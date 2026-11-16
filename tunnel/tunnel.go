// Package tunnel runs the public link: the kiro-tunnel helper (helper/kiro-tunnel) joins the
// user's tailnet with Tailscale Funnel and forwards every visitor to a loopback listener here,
// which serves the proxy's own handler. The helper is a separate download, so the proxy binary
// stays small; Manager fetches and checks it, runs it as a child process, reads its JSON status
// lines, and restarts it if it stops while the switch is on.
package tunnel

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// protocolVersion must match the helper's (helper/kiro-tunnel/status.go).
const protocolVersion = 1

// State is where the public link is, as the settings card shows it.
type State string

const (
	StateOff           State = "off"
	StateDownloading   State = "downloading"
	StateStarting      State = "starting"
	StateNeedsLogin    State = "needs-login"
	StateNeedsApproval State = "needs-approval"
	StateNeedsFunnel   State = "needs-funnel"
	StateRunning       State = "running"
	StateError         State = "error"
)

// Status is the link's state and what the user needs for it. Only the current state's fields
// are set.
type Status struct {
	State    State `json:"state"`
	Progress *int  `json:"progress,omitempty"`
	// Downloaded and Total count the helper download's compressed bytes; Total is 0 when the
	// server sends no size.
	Downloaded int64  `json:"downloaded,omitempty"`
	Total      int64  `json:"total,omitempty"`
	URL        string `json:"url,omitempty"`
	AuthURL    string `json:"authURL,omitempty"`
	EnableURL  string `json:"enableURL,omitempty"`
	AdminURL   string `json:"adminURL,omitempty"`
	Error      string `json:"error,omitempty"`
	// ErrorCode names the failure for the admin UI, which words it itself (see the Code*
	// constants); ErrorDetail is the underlying reason it shows as is. Error stays the English.
	ErrorCode   string `json:"errorCode,omitempty"`
	ErrorDetail string `json:"errorDetail,omitempty"`
	// SignedIn is whether this server holds a Tailscale sign-in that "Sign out" would end.
	SignedIn bool `json:"signedIn"`
	// FallbackHelper says an earlier version's helper (or, from source, the latest release's) is
	// running, because this version's could not be downloaded.
	FallbackHelper bool `json:"fallbackHelper,omitempty"`
	// KeyExpiry (RFC 3339) is when Tailscale signs this device out and the link stops, while
	// running; empty once the tailnet admin turns key expiry off for it. MachineURL is the
	// device's page in the admin console, where that is done.
	KeyExpiry  string `json:"keyExpiry,omitempty"`
	MachineURL string `json:"machineURL,omitempty"`
	// Publishing is set while running without a URL: the certificate is in, and the helper waits
	// for the link to answer from the internet, which can take Tailscale a few minutes.
	Publishing bool `json:"publishing,omitempty"`
}

// Codes in Status.ErrorCode. A code never changes once shipped.
const (
	CodeHelperStopped  = "helper_stopped"
	CodeHelperDownload = "helper_download_failed"
	CodeHelperStart    = "helper_start_failed"
	CodeHelperMismatch = "helper_mismatch"
	CodeListener       = "listener_failed"
	CodeHelperError    = "helper_error"
)

// failure is an error with its Status code and detail; Error() is the text it always had.
type failure struct {
	code   string
	detail string
	err    error
}

func (f *failure) Error() string { return f.err.Error() }

func (f *failure) Unwrap() error { return f.err }

// errorStatus is the error state for err, with its code and detail when it has them.
func errorStatus(err error) Status {
	st := Status{State: StateError, Error: err.Error()}
	var f *failure
	if errors.As(err, &f) {
		st.ErrorCode, st.ErrorDetail = f.code, f.detail
	}
	return st
}

// Options configures a Manager.
type Options struct {
	// DataDir holds the helper download (bin/) and its Tailscale state (tailscale/).
	DataDir string
	// Version is the release whose helper is downloaded.
	Version string
	// Handler serves the requests that come in through the link.
	Handler http.Handler
	// OnChange is called after every status change, outside the Manager's lock.
	OnChange func(Status)
	// Logf and Debugf log the link's progress and the helper's stderr.
	Logf, Debugf func(format string, args ...any)

	// For tests: the release folder base URL, a helper to run instead of looking one up, extra
	// arguments before the helper's own, the HTTP client, and the restart delays.
	ReleaseBaseURL string
	Binary         string
	BinaryArgs     []string
	Client         *http.Client
	RestartMin     time.Duration
	RestartMax     time.Duration
}

// Manager owns the helper process. Its methods are safe to call from any goroutine.
type Manager struct {
	opts   Options
	secret string
	client *http.Client

	// applyMu runs Apply, Logout and Close one at a time.
	applyMu sync.Mutex

	mu       sync.Mutex
	status   Status
	hostname string
	run      *runHandle
	ln       net.Listener
	server   *http.Server
	// fallback says the running helper is not this version's (Status.FallbackHelper).
	fallback bool
}

// runHandle is one stretch of the switch being on: download, then the helper, restarted as
// needed, until cancel.
type runHandle struct {
	cancel context.CancelFunc
	done   chan struct{}

	mu       sync.Mutex
	stdin    io.WriteCloser // the running helper's stdin, nil between helpers
	stopping bool           // a sign-out is underway: do not restart the helper
}

// New returns a Manager with the link off.
func New(opts Options) *Manager {
	if opts.ReleaseBaseURL == "" {
		opts.ReleaseBaseURL = DefaultReleaseBaseURL
	}
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	if opts.Debugf == nil {
		opts.Debugf = func(string, ...any) {}
	}
	if opts.RestartMin <= 0 {
		opts.RestartMin = 2 * time.Second
	}
	if opts.RestartMax <= 0 {
		opts.RestartMax = 2 * time.Minute
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	m := &Manager{opts: opts, secret: hex.EncodeToString(buf), client: client}
	m.status = Status{State: StateOff, SignedIn: m.signedInMarker()}
	return m
}

// Status returns the link's current status.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.status
	if st.Progress != nil {
		p := *st.Progress
		st.Progress = &p
	}
	return st
}

// Apply turns the link on or off. A new device name while it is on restarts the helper, which
// re-registers the device under that name. So does Apply while the link has failed: "Try again"
// starts it now, not after the retry delay, which grows to RestartMax.
func (m *Manager) Apply(enabled bool, hostname string) {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	m.mu.Lock()
	if !enabled {
		run := m.run
		m.run = nil
		m.mu.Unlock()
		if run != nil {
			run.stop()
		}
		m.setStatus(Status{State: StateOff})
		return
	}
	if m.run != nil && m.hostname == hostname && m.status.State != StateError {
		m.mu.Unlock()
		return
	}
	old := m.run
	m.run = nil
	m.mu.Unlock()
	if old != nil {
		old.stop()
	}

	// The caller's response already shows the link starting, not the "off" it was.
	m.setStatus(Status{State: StateStarting})
	ctx, cancel := context.WithCancel(context.Background())
	run := &runHandle{cancel: cancel, done: make(chan struct{})}
	m.mu.Lock()
	m.run = run
	m.hostname = hostname
	m.mu.Unlock()
	go func() {
		defer close(run.done)
		m.loop(ctx, run, hostname)
	}()
}

// Close stops the helper and the loopback listener.
func (m *Manager) Close() {
	m.Apply(false, "")
	m.mu.Lock()
	server := m.server
	m.server, m.ln = nil, nil
	m.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
}

// Logout signs this server's device out of the tailnet, forgets the sign-in and turns the link
// off. The device leaves the user's Tailscale device list.
func (m *Manager) Logout(ctx context.Context) error {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	m.mu.Lock()
	run := m.run
	m.run = nil
	m.mu.Unlock()

	var err error
	if run != nil && run.askLogout() {
		select {
		case <-run.done:
		case <-ctx.Done():
			err = ctx.Err()
		}
		run.stop()
	} else {
		if run != nil {
			run.stop()
		}
		err = m.logoutWithHelper(ctx)
	}
	if rmErr := os.RemoveAll(m.stateDir()); rmErr != nil && err == nil {
		err = rmErr
	}
	m.setStatus(Status{State: StateOff})
	return err
}

// logoutWithHelper runs "kiro-tunnel logout" for a sign-in kept while the link is off.
func (m *Manager) logoutWithHelper(ctx context.Context) error {
	if !m.signedInMarker() {
		return nil
	}
	bin, ok, err := m.findBinary()
	if err != nil || !ok {
		// Without the helper the sign-in can only be forgotten here; the device stays in the
		// tailnet's list until it expires or is removed there.
		return nil
	}
	args := append(append([]string{}, m.opts.BinaryArgs...), "logout", "--dir", m.stateDir())
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("sign out of Tailscale: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (r *runHandle) stop() {
	r.cancel()
	<-r.done
}

// askLogout writes "logout" to the running helper, which signs out and exits.
func (r *runHandle) askLogout() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stdin == nil {
		return false
	}
	r.stopping = true
	_, err := io.WriteString(r.stdin, "logout\n")
	return err == nil
}

func (r *runHandle) isStopping() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopping
}

func (r *runHandle) setStdin(w io.WriteCloser) {
	r.mu.Lock()
	r.stdin = w
	r.mu.Unlock()
}

func (m *Manager) stateDir() string { return filepath.Join(m.opts.DataDir, "tailscale") }

// signedInMarker is a file the Manager writes once the helper reached the tailnet, so the card
// can offer "Sign out" while the link is off. Tailscale's own state file exists from the first
// start, before any sign-in.
func (m *Manager) markerPath() string { return filepath.Join(m.stateDir(), ".kiro-signed-in") }

func (m *Manager) signedInMarker() bool {
	_, err := os.Stat(m.markerPath())
	return err == nil
}

func (m *Manager) setStatus(st Status) {
	m.mu.Lock()
	st.SignedIn = m.signedInMarker()
	if st.State != StateOff {
		st.FallbackHelper = m.fallback
	}
	changed := !sameStatus(m.status, st)
	m.status = st
	m.mu.Unlock()
	if changed && m.opts.OnChange != nil {
		m.opts.OnChange(st)
	}
}

func (m *Manager) setProgress(pct int, downloaded, total int64) {
	m.setStatus(Status{State: StateDownloading, Progress: &pct, Downloaded: downloaded, Total: total})
}

func sameStatus(a, b Status) bool {
	pa, pb := -1, -1
	if a.Progress != nil {
		pa = *a.Progress
	}
	if b.Progress != nil {
		pb = *b.Progress
	}
	a.Progress, b.Progress = nil, nil
	return a == b && pa == pb
}

// loop keeps the helper running until ctx ends, waiting longer after each failure.
func (m *Manager) loop(ctx context.Context, run *runHandle, hostname string) {
	delay := m.opts.RestartMin
	for ctx.Err() == nil {
		reached, err := m.once(ctx, run, hostname)
		if ctx.Err() != nil || run.isStopping() {
			return
		}
		if reached {
			delay = m.opts.RestartMin
		}
		st := Status{State: StateError, Error: "The Tailscale helper stopped.", ErrorCode: CodeHelperStopped}
		if err != nil {
			st = errorStatus(err)
		}
		m.opts.Logf("[Tunnel] %s. Retrying in %s.", strings.TrimSuffix(st.Error, "."), delay.Round(time.Second))
		m.setStatus(st)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = min(delay*2, m.opts.RestartMax)
	}
}

// once gets the helper and runs it until it exits. reached says it got as far as the tailnet,
// which resets the retry delay.
func (m *Manager) once(ctx context.Context, run *runHandle, hostname string) (reached bool, err error) {
	bin, fallback, err := m.helper(ctx)
	if err != nil {
		return false, &failure{code: CodeHelperDownload, detail: err.Error(), err: err}
	}
	m.mu.Lock()
	m.fallback = fallback
	m.mu.Unlock()
	addr, err := m.ensureListener()
	if err != nil {
		return false, &failure{code: CodeListener, detail: err.Error(), err: fmt.Errorf("open the tunnel listener: %w", err)}
	}
	m.setStatus(Status{State: StateStarting})
	return m.runHelper(ctx, run, bin, hostname, addr)
}

// helper finds or downloads this version's helper. When it cannot be downloaded (its release is
// still publishing, or GitHub is out of reach), a helper already on disk from an earlier version
// runs instead, and fallback is true; a build from source with none on disk takes the latest
// release's. The next start tries this version's again, and its download removes the others.
func (m *Manager) helper(ctx context.Context) (path string, fallback bool, err error) {
	m.mu.Lock()
	m.fallback = false
	m.mu.Unlock()
	bin, ok, err := m.findBinary()
	if err != nil || ok {
		return bin, false, err
	}
	m.setStatus(Status{State: StateDownloading})
	m.opts.Logf("[Tunnel] Downloading the Tailscale helper for version %s", m.opts.Version)
	bin, err = m.download(ctx)
	if err == nil {
		return bin, false, nil
	}
	if ctx.Err() != nil {
		return "", false, ctx.Err()
	}
	if old, ok := m.olderHelper(); ok {
		m.opts.Logf("[Tunnel] %v. Running the helper already on disk (%s) until it is.", err, filepath.Base(old))
		return old, true, nil
	}
	if helperSHA256 == "" {
		m.opts.Logf("[Tunnel] %v. Trying the latest release's helper.", err)
		m.setStatus(Status{State: StateDownloading})
		latest, lerr := m.downloadLatest(ctx)
		if lerr == nil {
			return latest, true, nil
		}
		m.opts.Logf("[Tunnel] The latest release's helper: %v", lerr)
	}
	return "", false, err
}

func (m *Manager) ensureListener() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ln != nil {
		return m.ln.Addr().String(), nil
	}
	ln, server, err := listen(m.secret, m.opts.Handler)
	if err != nil {
		return "", err
	}
	m.ln, m.server = ln, server
	return ln.Addr().String(), nil
}

// helperLine is one status line from the helper.
type helperLine struct {
	Protocol  int    `json:"protocol"`
	State     string `json:"state"`
	AuthURL   string `json:"authURL"`
	EnableURL string `json:"enableURL"`
	AdminURL  string `json:"adminURL"`
	URL       string `json:"url"`
	Error     string `json:"error"`
	// Helpers from before key expiry was reported leave both empty.
	KeyExpiry  string `json:"keyExpiry"`
	MachineURL string `json:"machineURL"`
	// Helpers from before the reachability check never set it.
	Publishing bool `json:"publishing"`
}

var errProtocol = errors.New("the Tailscale helper does not match this version of Kiro Proxy")

func (m *Manager) runHelper(ctx context.Context, run *runHandle, bin, hostname, addr string) (bool, error) {
	if err := os.MkdirAll(m.stateDir(), 0o700); err != nil {
		return false, err
	}
	args := append(append([]string{}, m.opts.BinaryArgs...),
		"serve", "--dir", m.stateDir(), "--hostname", hostname, "--target", "http://"+addr)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), secretEnv+"="+m.secret)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return false, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return false, err
	}
	// Closing stdin asks the helper to shut down; it is killed if it has not after WaitDelay.
	cmd.Cancel = func() error { return stdin.Close() }
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Start(); err != nil {
		return false, &failure{code: CodeHelperStart, detail: err.Error(), err: fmt.Errorf("start the Tailscale helper: %w", err)}
	}
	run.setStdin(stdin)
	defer run.setStdin(nil)

	// The last stderr line is the helper's own error message when it exits with one.
	var lastErr string
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			m.opts.Debugf("[Tunnel] helper: %s", line)
			lastErr = line
		}
	}()

	reached := false
	var protoErr error
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		var line helperLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			m.opts.Debugf("[Tunnel] helper: %s", scanner.Text())
			continue
		}
		if line.Protocol != protocolVersion {
			protoErr = &failure{code: CodeHelperMismatch, err: fmt.Errorf("%w (protocol %d, want %d)", errProtocol, line.Protocol, protocolVersion)}
			_ = stdin.Close()
			go func() { _, _ = io.Copy(io.Discard, stdout) }()
			break
		}
		st, ok := m.statusFromHelper(line)
		if !ok {
			continue
		}
		if st.State == StateRunning || st.State == StateNeedsFunnel || st.State == StateNeedsApproval {
			if !reached {
				reached = true
				m.writeSignedInMarker()
			}
		}
		if st.State == StateRunning && st.URL != "" {
			m.opts.Logf("[Tunnel] Public link: %s", st.URL)
		}
		m.setStatus(st)
	}
	// Wait closes the pipes, so the stderr reader must finish first.
	<-stderrDone
	waitErr := cmd.Wait()
	if protoErr != nil {
		return reached, protoErr
	}
	if ctx.Err() != nil || run.isStopping() {
		return reached, nil
	}
	if waitErr != nil {
		if lastErr != "" {
			reason := strings.TrimPrefix(lastErr, "kiro-tunnel: ")
			return reached, &failure{code: CodeHelperStopped, detail: reason, err: fmt.Errorf("the Tailscale helper stopped: %s", reason)}
		}
		return reached, &failure{code: CodeHelperStopped, detail: waitErr.Error(), err: fmt.Errorf("the Tailscale helper stopped: %w", waitErr)}
	}
	return reached, nil
}

func (m *Manager) statusFromHelper(line helperLine) (Status, bool) {
	switch State(line.State) {
	case StateStarting:
		return Status{State: StateStarting}, true
	case StateNeedsLogin:
		return Status{State: StateNeedsLogin, AuthURL: line.AuthURL}, true
	case StateNeedsApproval:
		return Status{State: StateNeedsApproval, AdminURL: line.AdminURL}, true
	case StateNeedsFunnel:
		return Status{State: StateNeedsFunnel, EnableURL: line.EnableURL}, true
	case StateRunning:
		st := Status{State: StateRunning, URL: line.URL, MachineURL: line.MachineURL}
		st.Publishing = line.Publishing && line.URL == ""
		if _, err := time.Parse(time.RFC3339, line.KeyExpiry); err == nil {
			st.KeyExpiry = line.KeyExpiry
		}
		return st, true
	case StateError:
		return Status{State: StateError, Error: line.Error, ErrorCode: CodeHelperError, ErrorDetail: line.Error}, true
	}
	return Status{}, false
}

func (m *Manager) writeSignedInMarker() {
	if err := os.WriteFile(m.markerPath(), nil, 0o600); err != nil {
		m.opts.Debugf("[Tunnel] Failed to note the sign-in: %v", err)
	}
}
