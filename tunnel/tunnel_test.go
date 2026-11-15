package tunnel

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// The test binary doubles as a fake helper: Manager runs os.Args[0] with KIRO_TUNNEL_FAKE set,
// and TestMain hands such a run to fakeHelper instead of the tests.
const fakeEnv = "KIRO_TUNNEL_FAKE"

func TestMain(m *testing.M) {
	if scenario := os.Getenv(fakeEnv); scenario != "" {
		os.Exit(fakeHelper(scenario, os.Args[1:]))
	}
	os.Exit(m.Run())
}

func emit(v map[string]any) {
	if _, ok := v["protocol"]; !ok {
		v["protocol"] = protocolVersion
	}
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

func fakeHelper(scenario string, args []string) int {
	if len(args) > 0 && args[0] == "logout" {
		if out := os.Getenv("KIRO_TUNNEL_FAKE_OUT"); out != "" {
			_ = os.WriteFile(out, []byte("logged out"), 0o600)
		}
		return 0
	}
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	_ = fs.String("dir", "", "")
	hostname := fs.String("hostname", "", "")
	target := fs.String("target", "", "")
	if len(args) == 0 || args[0] != "serve" || fs.Parse(args[1:]) != nil {
		fmt.Fprintln(os.Stderr, "kiro-tunnel: bad arguments")
		return 2
	}
	switch scenario {
	case "badproto":
		emit(map[string]any{"protocol": 99, "state": "starting"})
	case "crash":
		if out := os.Getenv("KIRO_TUNNEL_FAKE_OUT"); out != "" {
			f, _ := os.OpenFile(out, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			_, _ = f.WriteString("run\n")
			_ = f.Close()
		}
		emit(map[string]any{"state": "starting"})
		fmt.Fprintln(os.Stderr, "kiro-tunnel: boom")
		return 1
	case "flow":
		emit(map[string]any{"state": "starting"})
		emit(map[string]any{"state": "needs-login", "authURL": "https://login.tailscale.com/a/abc"})
		// Call the proxy through the tunnel listener as the real helper does; the test handler
		// answers only a request that carries the secret and the visitor's address.
		req, _ := http.NewRequest(http.MethodGet, *target+"/probe", nil)
		req.Header.Set(headerSecret, os.Getenv(secretEnv))
		req.Header.Set(headerClient, "203.0.113.5:1234")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			emit(map[string]any{"state": "error", "error": err.Error()})
			break
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			emit(map[string]any{"state": "error", "error": string(body)})
			break
		}
		emit(map[string]any{"state": "running", "url": "https://" + *hostname + "." + string(body)})
	}
	// Run until the proxy closes stdin or asks for a sign-out.
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		if scanner.Text() == "logout" {
			if out := os.Getenv("KIRO_TUNNEL_FAKE_OUT"); out != "" {
				_ = os.WriteFile(out, []byte("logged out while serving"), 0o600)
			}
			return 0
		}
	}
	return 0
}

// probeHandler answers the fake helper's probe with the tailnet name when the tunnel listener
// passed the visitor's address on.
func probeHandler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !FromTunnel(r) || r.RemoteAddr != "203.0.113.5:1234" {
			http.Error(w, "probe: FromTunnel="+fmt.Sprint(FromTunnel(r))+" RemoteAddr="+r.RemoteAddr, http.StatusTeapot)
			return
		}
		io.WriteString(w, "tail1234.ts.net")
	})
}

func newTestManager(t *testing.T, scenario string) (*Manager, *[]Status) {
	t.Helper()
	t.Setenv(fakeEnv, scenario)
	var changes []Status
	changed := make(chan struct{}, 100)
	m := New(Options{
		DataDir:    t.TempDir(),
		Version:    "9.9.9",
		Handler:    probeHandler(t),
		Binary:     os.Args[0],
		RestartMin: 20 * time.Millisecond,
		RestartMax: 50 * time.Millisecond,
		OnChange: func(st Status) {
			changes = append(changes, st)
			select {
			case changed <- struct{}{}:
			default:
			}
		},
	})
	t.Cleanup(m.Close)
	return m, &changes
}

func waitStatus(t *testing.T, m *Manager, want func(Status) bool) Status {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if st := m.Status(); want(st) {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("status never matched; last %+v", m.Status())
	return Status{}
}

func TestManagerReachesRunningThroughTheTunnelListener(t *testing.T) {
	m, _ := newTestManager(t, "flow")
	if st := m.Status(); st.State != StateOff || st.SignedIn {
		t.Fatalf("initial status = %+v", st)
	}
	m.Apply(true, "kiro-proxy")
	if st := m.Status(); st.State == StateOff {
		t.Fatal("Apply returned with the link still off")
	}
	st := waitStatus(t, m, func(s Status) bool { return s.State == StateRunning || s.State == StateError })
	if st.State != StateRunning || st.URL != "https://kiro-proxy.tail1234.ts.net" {
		t.Fatalf("status = %+v", st)
	}
	if !st.SignedIn {
		t.Error("running did not note the sign-in")
	}

	m.Apply(false, "kiro-proxy")
	st = m.Status()
	if st.State != StateOff || !st.SignedIn {
		t.Errorf("after switching off = %+v, want off and still signed in", st)
	}
}

func TestManagerRestartsWithANewDeviceName(t *testing.T) {
	m, _ := newTestManager(t, "flow")
	m.Apply(true, "first")
	waitStatus(t, m, func(s Status) bool { return s.URL == "https://first.tail1234.ts.net" })
	m.Apply(true, "second")
	waitStatus(t, m, func(s Status) bool { return s.URL == "https://second.tail1234.ts.net" })
}

func TestManagerReportsTheHelpersError(t *testing.T) {
	m, _ := newTestManager(t, "crash")
	m.Apply(true, "kiro-proxy")
	st := waitStatus(t, m, func(s Status) bool { return s.State == StateError })
	if !strings.Contains(st.Error, "boom") {
		t.Errorf("error = %q, want the helper's message", st.Error)
	}
}

func TestTryAgainRestartsAFailedLinkNow(t *testing.T) {
	runs := filepath.Join(t.TempDir(), "runs")
	t.Setenv("KIRO_TUNNEL_FAKE_OUT", runs)
	m, _ := newTestManager(t, "crash")
	// The helper's own retry would wait an hour, so only Apply can start it again.
	m.opts.RestartMin, m.opts.RestartMax = time.Hour, time.Hour
	countRuns := func() int {
		b, _ := os.ReadFile(runs)
		return strings.Count(string(b), "run\n")
	}
	m.Apply(true, "kiro-proxy")
	waitStatus(t, m, func(s Status) bool { return s.State == StateError })
	if n := countRuns(); n != 1 {
		t.Fatalf("runs = %d, want 1", n)
	}
	m.Apply(true, "kiro-proxy")
	deadline := time.Now().Add(15 * time.Second)
	for countRuns() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := countRuns(); n != 2 {
		t.Fatalf("runs after Try again = %d, want 2", n)
	}
}

func TestManagerRefusesAnotherProtocol(t *testing.T) {
	m, _ := newTestManager(t, "badproto")
	m.Apply(true, "kiro-proxy")
	st := waitStatus(t, m, func(s Status) bool { return s.State == StateError })
	if !strings.Contains(st.Error, "does not match") {
		t.Errorf("error = %q", st.Error)
	}
}

func TestLogoutWhileRunningSignsOutAndForgets(t *testing.T) {
	m, _ := newTestManager(t, "flow")
	out := filepath.Join(t.TempDir(), "out")
	t.Setenv("KIRO_TUNNEL_FAKE_OUT", out)
	m.Apply(true, "kiro-proxy")
	waitStatus(t, m, func(s Status) bool { return s.State == StateRunning })

	if err := m.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != "logged out while serving" {
		t.Errorf("helper output = %q, want a sign-out through stdin", b)
	}
	if st := m.Status(); st.State != StateOff || st.SignedIn {
		t.Errorf("after sign-out = %+v", st)
	}
	if _, err := os.Stat(m.stateDir()); !os.IsNotExist(err) {
		t.Errorf("state dir still there: %v", err)
	}
}

func TestLogoutWhileOffRunsTheHelpersLogout(t *testing.T) {
	m, _ := newTestManager(t, "flow")
	out := filepath.Join(t.TempDir(), "out")
	t.Setenv("KIRO_TUNNEL_FAKE_OUT", out)
	if err := os.MkdirAll(m.stateDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	m.writeSignedInMarker()

	if err := m.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != "logged out" {
		t.Errorf("helper output = %q, want the logout command", b)
	}
	if st := m.Status(); st.SignedIn {
		t.Error("still signed in")
	}
}

func TestMiddlewareAdmitsOnlyTheHelper(t *testing.T) {
	var seen *http.Request
	h := middleware("secret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusForbidden || seen != nil {
		t.Fatalf("no secret: code %d, reached handler %v", rec.Code, seen != nil)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(headerSecret, "wrong")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wrong secret: code %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(headerSecret, "secret")
	req.Header.Set(headerClient, "[2001:db8::1]:443")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if seen == nil || !FromTunnel(seen) || seen.RemoteAddr != "[2001:db8::1]:443" {
		t.Fatalf("request = %+v", seen)
	}
	if seen.Header.Get(headerSecret) != "" || seen.Header.Get(headerClient) != "" {
		t.Error("tunnel headers reached the proxy")
	}

	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(headerSecret, "secret")
	req.Header.Set(headerClient, "not an address")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if seen.RemoteAddr != unknownVisitor {
		t.Errorf("RemoteAddr = %q, want %q", seen.RemoteAddr, unknownVisitor)
	}
}

func TestFromTunnelIsFalseForOtherRequests(t *testing.T) {
	if FromTunnel(httptest.NewRequest(http.MethodGet, "/", nil)) {
		t.Error("a plain request counts as a tunnel request")
	}
}

// releaseServer serves one release folder with a helper and SHA256SUMS.txt.
func releaseServer(t *testing.T, binary []byte, sums func(gz []byte) string) *httptest.Server {
	t.Helper()
	if _, err := platformName(runtime.GOOS, runtime.GOARCH); err != nil {
		t.Skip(err)
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(binary)
	zw.Close()
	asset := assetName()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/9.9.9/" + asset:
			w.Write(gz.Bytes())
		case "/9.9.9/SHA256SUMS.txt":
			io.WriteString(w, sums(gz.Bytes()))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func downloadManager(t *testing.T, base string) *Manager {
	t.Setenv(binEnv, "")
	return New(Options{DataDir: t.TempDir(), Version: "9.9.9", ReleaseBaseURL: base})
}

func TestDownloadChecksAgainstTheReleaseSums(t *testing.T) {
	binary := []byte("#!/bin/sh\necho helper\n")
	srv := releaseServer(t, binary, func(gz []byte) string {
		return sum([]byte("other")) + "  kiro-tunnel-other.gz\n" + sum(gz) + "  " + assetName() + "\n"
	})
	m := downloadManager(t, srv.URL)
	var progress []int
	var last Status
	m.opts.OnChange = func(st Status) {
		if st.Progress != nil {
			progress = append(progress, *st.Progress)
			last = st
		}
	}
	path, err := m.download(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, binary) {
		t.Errorf("saved helper = %q", got)
	}
	if len(progress) == 0 || progress[len(progress)-1] != 100 {
		t.Errorf("progress = %v, want it to end at 100", progress)
	}
	if last.Total <= 0 || last.Downloaded != last.Total {
		t.Errorf("bytes at 100%% = %d of %d, want all of a known size", last.Downloaded, last.Total)
	}
	// The next start uses the saved helper.
	if p, ok, err := m.findBinary(); err != nil || !ok || p != path {
		t.Errorf("findBinary = %q %v %v", p, ok, err)
	}
}

func assetName() string {
	platform, _ := platformName(runtime.GOOS, runtime.GOARCH)
	return "kiro-tunnel-" + platform + ".gz"
}

func TestDownloadRefusesAChecksumMismatch(t *testing.T) {
	srv := releaseServer(t, []byte("helper"), func([]byte) string {
		return sum([]byte("tampered")) + "  " + assetName() + "\n"
	})
	m := downloadManager(t, srv.URL)
	if _, err := m.download(context.Background()); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("err = %v, want a checksum error", err)
	}
	if _, err := os.Stat(m.cachedBinaryPath()); !os.IsNotExist(err) {
		t.Error("a mismatched helper was saved")
	}
}

func TestDownloadUsesTheBuiltInChecksum(t *testing.T) {
	binary := []byte("built-in helper")
	srv := releaseServer(t, binary, func([]byte) string { return "" })
	old := helperSHA256
	t.Cleanup(func() { helperSHA256 = old })

	helperSHA256 = sum(binary)
	m := downloadManager(t, srv.URL)
	if _, err := m.download(context.Background()); err != nil {
		t.Fatalf("matching built-in checksum: %v", err)
	}

	helperSHA256 = sum([]byte("something else"))
	m = downloadManager(t, srv.URL)
	if _, err := m.download(context.Background()); err == nil {
		t.Fatal("a helper that differs from the built-in checksum was accepted")
	}
}

func TestDownloadNamesAMissingRelease(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	m := downloadManager(t, srv.URL)
	_, err := m.download(context.Background())
	if err == nil || !strings.Contains(err.Error(), "9.9.9") {
		t.Fatalf("err = %v, want it to name the release", err)
	}
}

func TestPlatformNamesMatchTheReleaseAssets(t *testing.T) {
	want := map[string]string{
		"linux/amd64": "linux-x64", "linux/arm64": "linux-arm64",
		"darwin/amd64": "macos-intel", "darwin/arm64": "macos-apple-silicon",
		"windows/amd64": "windows-x64", "windows/arm64": "windows-arm64",
	}
	for target, name := range want {
		goos, goarch, _ := strings.Cut(target, "/")
		if got, err := platformName(goos, goarch); err != nil || got != name {
			t.Errorf("platformName(%s) = %q %v, want %q", target, got, err, name)
		}
	}
	if _, err := platformName("plan9", "386"); err == nil {
		t.Error("plan9 has a helper")
	}
}

func TestBinEnvWins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "my-helper")
	os.WriteFile(path, []byte("x"), 0o755)
	t.Setenv(binEnv, path)
	m := New(Options{DataDir: t.TempDir(), Version: "9.9.9"})
	if got, ok, err := m.findBinary(); err != nil || !ok || got != path {
		t.Errorf("findBinary = %q %v %v, want %s", got, ok, err, path)
	}
	t.Setenv(binEnv, filepath.Join(t.TempDir(), "missing"))
	if _, _, err := m.findBinary(); err == nil {
		t.Error("a missing KIRO_TUNNEL_BIN was accepted")
	}
}

// filesServer serves fixed paths; every other path is a 404. hits counts requests per path.
func filesServer(t *testing.T, files map[string][]byte) (*httptest.Server, map[string]int) {
	t.Helper()
	if _, err := platformName(runtime.GOOS, runtime.GOARCH); err != nil {
		t.Skip(err)
	}
	hits := map[string]int{}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		body, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, hits
}

func gzipped(b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(b)
	zw.Close()
	return buf.Bytes()
}

func writeHelper(t *testing.T, m *Manager, name, body string) string {
	t.Helper()
	path := filepath.Join(m.opts.DataDir, "bin", name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAnOlderHelperRunsWhileThisVersionsIsMissing(t *testing.T) {
	srv, _ := filesServer(t, nil)
	m := downloadManager(t, srv.URL)
	old := writeHelper(t, m, "kiro-tunnel-9.9.8", "old helper")

	path, fallback, err := m.helper(context.Background())
	if err != nil || path != old || !fallback {
		t.Fatalf("helper = %q %v %v, want the older helper as a fallback", path, fallback, err)
	}

	m.mu.Lock()
	m.fallback = true
	m.mu.Unlock()
	m.setStatus(Status{State: StateRunning, URL: "https://box.example.ts.net"})
	if !m.Status().FallbackHelper {
		t.Error("the running status does not say an older helper runs")
	}
	m.setStatus(Status{State: StateOff})
	if m.Status().FallbackHelper {
		t.Error("the off status still says an older helper runs")
	}
}

func TestAMissingHelperSaysItIsNotPublishedYet(t *testing.T) {
	srv, _ := filesServer(t, nil)
	old := helperSHA256
	t.Cleanup(func() { helperSHA256 = old })
	helperSHA256 = sum([]byte("a release build"))

	m := downloadManager(t, srv.URL)
	_, _, err := m.helper(context.Background())
	if err == nil || !strings.Contains(err.Error(), "9.9.9") || !strings.Contains(err.Error(), "not on GitHub yet") {
		t.Fatalf("err = %v, want it to say version 9.9.9's helper is not published yet", err)
	}
	if strings.Contains(err.Error(), "http") {
		t.Errorf("err = %v, want no URL in the message the card shows", err)
	}
	// A release build never takes another release's helper.
	if _, err := os.Stat(m.latestBinaryPath()); !os.IsNotExist(err) {
		t.Error("a release build downloaded the latest release's helper")
	}
}

func TestASourceBuildTakesTheLatestReleasesHelper(t *testing.T) {
	old := helperSHA256
	t.Cleanup(func() { helperSHA256 = old })
	helperSHA256 = ""

	binary := []byte("latest helper")
	gz := gzipped(binary)
	srv, hits := filesServer(t, map[string][]byte{
		"/latest/" + assetName(): gz,
		"/latest/SHA256SUMS.txt": []byte(sum(gz) + "  " + assetName() + "\n"),
	})
	m := downloadManager(t, srv.URL)

	path, fallback, err := m.helper(context.Background())
	if err != nil || path != m.latestBinaryPath() || !fallback {
		t.Fatalf("helper = %q %v %v, want the latest release's helper as a fallback", path, fallback, err)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, binary) {
		t.Errorf("saved helper = %q", got)
	}
	// The next start runs it from disk instead of downloading it again.
	if path, fallback, err := m.helper(context.Background()); err != nil || path != m.latestBinaryPath() || !fallback {
		t.Fatalf("second start = %q %v %v", path, fallback, err)
	}
	if n := hits["/latest/"+assetName()]; n != 1 {
		t.Errorf("the latest helper was downloaded %d times, want once", n)
	}
}

func TestASourceBuildRefusesALatestHelperThatFailsItsChecksum(t *testing.T) {
	old := helperSHA256
	t.Cleanup(func() { helperSHA256 = old })
	helperSHA256 = ""

	srv, _ := filesServer(t, map[string][]byte{
		"/latest/" + assetName(): gzipped([]byte("tampered")),
		"/latest/SHA256SUMS.txt": []byte(sum([]byte("other")) + "  " + assetName() + "\n"),
	})
	m := downloadManager(t, srv.URL)
	if _, _, err := m.helper(context.Background()); err == nil {
		t.Fatal("a latest helper with a wrong checksum ran")
	}
	if _, err := os.Stat(m.latestBinaryPath()); !os.IsNotExist(err) {
		t.Error("the mismatched latest helper was saved")
	}
}

func TestThisVersionsHelperReplacesTheFallbacks(t *testing.T) {
	binary := []byte("this version's helper")
	srv := releaseServer(t, binary, func(gz []byte) string { return sum(gz) + "  " + assetName() + "\n" })
	m := downloadManager(t, srv.URL)
	older := writeHelper(t, m, "kiro-tunnel-9.9.8", "old helper")
	latest := writeHelper(t, m, "kiro-tunnel-latest", "latest helper")

	path, fallback, err := m.helper(context.Background())
	if err != nil || path != m.cachedBinaryPath() || fallback {
		t.Fatalf("helper = %q %v %v, want this version's helper", path, fallback, err)
	}
	for _, p := range []string{older, latest} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s was kept after this version's helper arrived", filepath.Base(p))
		}
	}
}

func TestLatestBaseURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/o/r/releases/download":  "https://github.com/o/r/releases/latest/download/",
		"https://github.com/o/r/releases/download/": "https://github.com/o/r/releases/latest/download/",
		"http://127.0.0.1:8099":                     "http://127.0.0.1:8099/latest/",
	} {
		if got := latestBaseURL(in); got != want {
			t.Errorf("latestBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}
