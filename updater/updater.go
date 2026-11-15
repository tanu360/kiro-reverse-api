// Package updater lets a binary install update itself from the admin panel: Manager downloads
// this platform's release archive from GitHub, checks it against the release's SHA256SUMS.txt,
// swaps the running executable for the program inside (the previous one stays next to it as
// <name>.old), and on request runs the new program in this process's place. A server in a
// container never updates itself this way: its image does.
package updater

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultReleaseBaseURL is where the release workflow uploads the archives, one folder per tag.
const DefaultReleaseBaseURL = "https://github.com/tanu360/kiro-reverse-api/releases/download"

// State is where an update is, as the update dialog shows it.
type State string

const (
	StateIdle        State = "idle"
	StateDownloading State = "downloading"
	StateReady       State = "ready"
	StateRestarting  State = "restarting"
	StateError       State = "error"
)

// Reasons a server cannot update itself (Status.Reason).
const (
	ReasonContainer   = "container"
	ReasonPlatform    = "platform"
	ReasonNotWritable = "not_writable"
)

// Status is GET /admin/api/update. Only the current state's fields are set.
type Status struct {
	State     State `json:"state"`
	Supported bool  `json:"supported"`
	// Reason says why the server cannot update itself, when Supported is false.
	Reason string `json:"reason,omitempty"`
	// Path is the executable an update replaces.
	Path string `json:"path,omitempty"`
	// Version is the release being downloaded, installed, restarted into, or that failed.
	Version  string `json:"version,omitempty"`
	Progress *int   `json:"progress,omitempty"`
	// Downloaded and Total count the archive's bytes; Total is 0 when the server sends no size.
	Downloaded int64  `json:"downloaded,omitempty"`
	Total      int64  `json:"total,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Options configures a Manager.
type Options struct {
	// Version is the running release; only a newer one can be installed.
	Version string
	// OnChange is called after every status change, outside the Manager's lock.
	OnChange func(Status)
	// Logf logs the update's progress.
	Logf func(format string, args ...any)

	// For tests: the release folder base URL, the HTTP client, the executable to replace, whether
	// the server runs in a container, and the platform whose archive is downloaded.
	ReleaseBaseURL string
	Client         *http.Client
	Executable     func() (string, error)
	InContainer    *bool
	GOOS, GOARCH   string
}

// Start refuses a request with one of these; the error's text is for the user.
var (
	ErrVersion     = errors.New("updater: bad version")
	ErrUnsupported = errors.New("updater: unsupported")
	ErrBusy        = errors.New("updater: busy")
)

type startError struct {
	kind error
	msg  string
}

func (e *startError) Error() string { return e.msg }
func (e *startError) Unwrap() error { return e.kind }

// Manager runs one update at a time. Its methods are safe to call from any goroutine.
type Manager struct {
	opts   Options
	client *http.Client
	// archive is this platform's release asset and binary the program's path inside it; both
	// are empty when no release is published for the platform.
	archive, binary string
	inContainer     bool
	// exe is resolved once, at New: on Linux os.Executable names the running file, which is the
	// ".old" backup once an update has been swapped in.
	exe string

	mu     sync.Mutex
	status Status
	// installed says an update replaced exe since this process started, so exe+".old" is the
	// program that is running.
	installed bool
}

// tempPrefix starts every file the updater writes next to the executable before it is complete.
const tempPrefix = ".kiro-proxy-update-"

// containerMarkers are the files proxy/version_info.go checks: Docker writes /.dockerenv and
// Podman /run/.containerenv in the root of every container.
var containerMarkers = []string{"/.dockerenv", "/run/.containerenv"}

// New returns a Manager with no update underway.
func New(opts Options) *Manager {
	if opts.ReleaseBaseURL == "" {
		opts.ReleaseBaseURL = DefaultReleaseBaseURL
	}
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	if opts.Executable == nil {
		opts.Executable = os.Executable
	}
	if opts.GOOS == "" {
		opts.GOOS = runtime.GOOS
	}
	if opts.GOARCH == "" {
		opts.GOARCH = runtime.GOARCH
	}
	client := opts.Client
	if client == nil {
		// The default transport, so HTTPS_PROXY applies; a slow link gets ten minutes.
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	m := &Manager{opts: opts, client: client}
	if opts.InContainer != nil {
		m.inContainer = *opts.InContainer
	} else {
		m.inContainer = inContainer(containerMarkers)
	}
	if platform, ok := platformName(opts.GOOS, opts.GOARCH); ok {
		name := "kiro-proxy-" + platform
		program := "kiro-proxy"
		if opts.GOOS == "windows" {
			m.archive = name + ".zip"
			program += ".exe"
		} else {
			m.archive = name + ".tar.gz"
		}
		m.binary = name + "/" + program
	}
	if exe, err := opts.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			m.exe = resolved
		}
	}
	m.status = Status{State: StateIdle}
	m.checkLocked()
	if m.status.Supported {
		removeStaleTemps(filepath.Dir(m.exe))
	}
	return m
}

func inContainer(markers []string) bool {
	for _, marker := range markers {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return false
}

// checkLocked works out whether this server can update itself.
func (m *Manager) checkLocked() {
	st := &m.status
	st.Supported, st.Reason, st.Path = false, "", m.exe
	switch {
	case m.inContainer:
		st.Reason = ReasonContainer
	case m.archive == "":
		st.Reason = ReasonPlatform
	case m.exe == "" || !dirWritable(filepath.Dir(m.exe)):
		st.Reason = ReasonNotWritable
	default:
		st.Supported = true
	}
}

// dirWritable tries what an update does first: create a file next to the executable.
func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// removeStaleTemps deletes what an update that was cut short (a crash, a kill) left next to the
// executable. A file younger than an hour may be another process's download, as when two
// servers run the same program, so it stays.
func removeStaleTemps(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), tempPrefix) || !e.Type().IsRegular() {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > time.Hour {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// Status returns the update's current status.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.State == StateIdle || m.status.State == StateError {
		// The folder's permissions may have been fixed since the last look.
		m.checkLocked()
	}
	return copyStatus(m.status)
}

// Start begins downloading and installing version in the background. It returns false with no
// error when that version is already installed and waiting for a restart.
func (m *Manager) Start(version string) (bool, error) {
	m.mu.Lock()
	if m.status.State == StateIdle || m.status.State == StateError {
		m.checkLocked()
	}
	if !m.status.Supported {
		reason, path := m.status.Reason, m.status.Path
		m.mu.Unlock()
		return false, &startError{ErrUnsupported, unsupportedMessage(reason, path)}
	}
	v, ok := normalizeVersion(version)
	if !ok {
		m.mu.Unlock()
		return false, &startError{ErrVersion, "The version must be three numbers, like 3.6.0."}
	}
	if !newer(v, m.opts.Version) {
		m.mu.Unlock()
		return false, &startError{ErrVersion, fmt.Sprintf("Version %s is not newer than the running version %s.", v, m.opts.Version)}
	}
	switch {
	case m.status.State == StateDownloading:
		m.mu.Unlock()
		return false, &startError{ErrBusy, "An update is already downloading."}
	case m.status.State == StateRestarting:
		m.mu.Unlock()
		return false, &startError{ErrBusy, "The server is restarting into the update."}
	case m.status.State == StateReady && m.status.Version == v:
		m.mu.Unlock()
		return false, nil
	}
	m.status = Status{State: StateDownloading, Version: v, Supported: true, Path: m.exe}
	st := copyStatus(m.status)
	m.mu.Unlock()
	m.notify(st)
	go m.run(v)
	return true, nil
}

func unsupportedMessage(reason, path string) string {
	switch reason {
	case ReasonContainer:
		return "This server runs in a container; update it by pulling the new image."
	case ReasonPlatform:
		return "No release is published for this platform."
	}
	if path == "" {
		return "The server cannot find its own program file."
	}
	return fmt.Sprintf("The server cannot write to the folder that holds %s.", path)
}

// BeginRestart moves a ready update to restarting and returns the new status. It returns false
// when no update is ready.
func (m *Manager) BeginRestart() (Status, bool) {
	m.mu.Lock()
	if m.status.State != StateReady {
		st := copyStatus(m.status)
		m.mu.Unlock()
		return st, false
	}
	m.status.State = StateRestarting
	st := copyStatus(m.status)
	m.mu.Unlock()
	m.notify(st)
	return st, true
}

// Restart runs the installed program in place of this process, with the same arguments and
// environment. The caller stops the server first. On Unix the process keeps its ID and Restart
// returns only on failure; on Windows the new program starts as a new process and this one
// exits.
func (m *Manager) Restart() error {
	if m.exe == "" {
		return errors.New("the server cannot find its own program file")
	}
	m.opts.Logf("[Update] Restarting into %s", m.exe)
	return reexec(m.exe)
}

func (m *Manager) run(version string) {
	m.opts.Logf("[Update] Downloading version %s (%s)", version, m.archive)
	if err := m.install(version); err != nil {
		m.opts.Logf("[Update] Version %s failed: %v", version, err)
		m.setStatus(Status{State: StateError, Version: version, Error: err.Error()})
		return
	}
	m.opts.Logf("[Update] Version %s is installed at %s; restart the server to run it", version, m.exe)
	m.setStatus(Status{State: StateReady, Version: version})
}

func (m *Manager) setStatus(st Status) {
	m.mu.Lock()
	st.Supported, st.Reason, st.Path = m.status.Supported, m.status.Reason, m.status.Path
	changed := !sameStatus(m.status, st)
	m.status = st
	st = copyStatus(st)
	m.mu.Unlock()
	if changed {
		m.notify(st)
	}
}

func (m *Manager) setProgress(version string, pct int, downloaded, total int64) {
	m.setStatus(Status{State: StateDownloading, Version: version, Progress: &pct, Downloaded: downloaded, Total: total})
}

func (m *Manager) notify(st Status) {
	if m.opts.OnChange != nil {
		m.opts.OnChange(st)
	}
}

func copyStatus(st Status) Status {
	if st.Progress != nil {
		p := *st.Progress
		st.Progress = &p
	}
	return st
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

var versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// normalizeVersion accepts a release tag with or without a leading "v".
func normalizeVersion(v string) (string, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if !versionPattern.MatchString(v) {
		return "", false
	}
	if _, ok := parseVersion(v); !ok {
		return "", false
	}
	return v, true
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// newer reports whether release a comes after b, comparing each number in turn. A running
// version that is not three numbers (a build from source with its own version string) takes any
// release.
func newer(a, b string) bool {
	pa, ok := parseVersion(a)
	if !ok {
		return false
	}
	pb, ok := parseVersion(b)
	if !ok {
		return true
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}
