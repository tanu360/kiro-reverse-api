package updater

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
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

type entry struct {
	name string
	body string
	dir  bool
}

func tarGz(t *testing.T, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Mode: 0o755, Size: int64(len(e.body)), Typeflag: tar.TypeReg}
		if e.dir {
			hdr = &tar.Header{Name: e.name, Mode: 0o755, Typeflag: tar.TypeDir}
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipArchive(t *testing.T, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		if e.dir {
			if _, err := zw.Create(e.name); err != nil {
				t.Fatal(err)
			}
			continue
		}
		w, err := zw.Create(e.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFindChecksum(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	tests := []struct {
		name   string
		sums   string
		asset  string
		want   string
		wantOK bool
	}{
		{"text mode", sum + "  kiro-proxy-linux-x64.tar.gz\n", "kiro-proxy-linux-x64.tar.gz", sum, true},
		{"binary mode", sum + " *kiro-proxy-linux-x64.tar.gz\n", "kiro-proxy-linux-x64.tar.gz", sum, true},
		{"upper case", strings.ToUpper(sum) + "  a.zip\n", "a.zip", sum, true},
		{"among others", "00  other\n" + sum + "  kiro-proxy-windows-x64.zip\n", "kiro-proxy-windows-x64.zip", sum, true},
		{"missing", sum + "  kiro-proxy-linux-arm64.tar.gz\n", "kiro-proxy-linux-x64.tar.gz", "", false},
		{"prefix only", sum + "  kiro-proxy-linux-x64.tar.gz.sig\n", "kiro-proxy-linux-x64.tar.gz", "", false},
		{"short sum", "abcd  a.zip\n", "a.zip", "", false},
		{"not hex", strings.Repeat("zz", 32) + "  a.zip\n", "a.zip", "", false},
		{"empty", "", "a.zip", "", false},
	}
	for _, tc := range tests {
		got, ok := findChecksum(strings.NewReader(tc.sums), tc.asset)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("%s: got %q %v, want %q %v", tc.name, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestExtract(t *testing.T) {
	const want = "kiro-proxy-linux-x64/kiro-proxy"
	tests := []struct {
		name    string
		entries []entry
		body    string
		err     string
	}{
		{
			name: "finds the program among other files",
			entries: []entry{
				{name: "kiro-proxy-linux-x64/", dir: true},
				{name: "kiro-proxy-linux-x64/LICENSE", body: "license"},
				{name: "kiro-proxy-linux-x64/kiro-proxy", body: "new program"},
				{name: "kiro-proxy-linux-x64/README.md", body: "readme"},
			},
			body: "new program",
		},
		{
			name:    "accepts a leading ./",
			entries: []entry{{name: "./kiro-proxy-linux-x64/kiro-proxy", body: "dot"}},
			body:    "dot",
		},
		{
			name:    "no program",
			entries: []entry{{name: "kiro-proxy-linux-x64/LICENSE", body: "license"}},
			err:     "does not hold",
		},
		{
			name:    "program at the top level is not ours",
			entries: []entry{{name: "kiro-proxy", body: "loose"}},
			err:     "does not hold",
		},
		{
			name: "climbs out",
			entries: []entry{
				{name: "kiro-proxy-linux-x64/kiro-proxy", body: "new program"},
				{name: "../evil", body: "x"},
			},
			err: "unsafe path",
		},
		{
			name:    "climbs out and back",
			entries: []entry{{name: "kiro-proxy-linux-x64/../kiro-proxy-linux-x64/kiro-proxy", body: "x"}},
			err:     "unsafe path",
		},
		{
			name:    "absolute",
			entries: []entry{{name: "/kiro-proxy-linux-x64/kiro-proxy", body: "x"}},
			err:     "unsafe path",
		},
	}
	formats := []struct {
		name    string
		archive string
		build   func(*testing.T, []entry) []byte
	}{
		{"tar.gz", "kiro-proxy-linux-x64.tar.gz", tarGz},
		{"zip", "kiro-proxy-linux-x64.zip", zipArchive},
	}
	for _, format := range formats {
		for _, tc := range tests {
			t.Run(format.name+"/"+tc.name, func(t *testing.T) {
				data := format.build(t, tc.entries)
				path := filepath.Join(t.TempDir(), format.archive)
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
				f, err := os.Open(path)
				if err != nil {
					t.Fatal(err)
				}
				defer f.Close()
				var out bytes.Buffer
				err = extractBinary(f, int64(len(data)), format.archive, want, &out)
				if tc.err != "" {
					if err == nil || !strings.Contains(err.Error(), tc.err) {
						t.Fatalf("err = %v, want one with %q", err, tc.err)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if out.String() != tc.body {
					t.Fatalf("extracted %q, want %q", out.String(), tc.body)
				}
			})
		}
	}
}

func TestVersionRules(t *testing.T) {
	tests := []struct {
		in, running string
		valid       bool
		newer       bool
	}{
		{"3.6.0", "3.5.8", true, true},
		{"v3.6.0", "3.5.8", true, true},
		{"3.5.10", "3.5.9", true, true},
		{"4.0.0", "3.99.99", true, true},
		{"3.5.8", "3.5.8", true, false},
		{"3.5.7", "3.5.8", true, false},
		{"2.10.0", "3.0.0", true, false},
		{"3.6", "3.5.8", false, false},
		{"3.6.0-rc1", "3.5.8", false, false},
		{"latest", "3.5.8", false, false},
		{"", "3.5.8", false, false},
		{"99999999999999999999.0.0", "3.5.8", false, false},
		{"3.6.0", "dev", true, true},
	}
	for _, tc := range tests {
		v, ok := normalizeVersion(tc.in)
		if ok != tc.valid {
			t.Errorf("normalizeVersion(%q) ok = %v, want %v", tc.in, ok, tc.valid)
			continue
		}
		if ok && newer(v, tc.running) != tc.newer {
			t.Errorf("newer(%q, %q) = %v, want %v", v, tc.running, !tc.newer, tc.newer)
		}
	}
}

// release serves one version's archive and SHA256SUMS.txt the way GitHub's release downloads do.
type release struct {
	version string
	archive string
	data    []byte
	sum     string // overrides the archive's real checksum when set
	noSums  bool
	mu      sync.Mutex
	agents  []string
}

func (r *release) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	r.agents = append(r.agents, req.Header.Get("User-Agent"))
	r.mu.Unlock()
	switch req.URL.Path {
	case "/" + r.version + "/SHA256SUMS.txt":
		if r.noSums {
			http.NotFound(w, req)
			return
		}
		sum := r.sum
		if sum == "" {
			h := sha256.Sum256(r.data)
			sum = hex.EncodeToString(h[:])
		}
		fmt.Fprintf(w, "%s  kiro-tunnel-linux-x64.gz\n%s  %s\n", strings.Repeat("0", 64), sum, r.archive)
	case "/" + r.version + "/" + r.archive:
		w.Header().Set("Content-Length", fmt.Sprint(len(r.data)))
		w.Write(r.data)
	default:
		http.NotFound(w, req)
	}
}

type fixture struct {
	m      *Manager
	exe    string
	mu     sync.Mutex
	events []Status
}

func (f *fixture) seen() []Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Status(nil), f.events...)
}

func newFixture(t *testing.T, goos, goarch, baseURL string) *fixture {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "kiro-proxy")
	if err := os.WriteFile(exe, []byte("old program"), 0o755); err != nil {
		t.Fatal(err)
	}
	f := &fixture{exe: exe}
	no := false
	f.m = New(Options{
		Version:        "3.5.8",
		ReleaseBaseURL: baseURL,
		Executable:     func() (string, error) { return exe, nil },
		InContainer:    &no,
		GOOS:           goos,
		GOARCH:         goarch,
		OnChange: func(st Status) {
			f.mu.Lock()
			f.events = append(f.events, st)
			f.mu.Unlock()
		},
	})
	// The temp dir may sit behind a symlink (macOS /var), which New resolves.
	f.exe = f.m.exe
	return f
}

func waitFor(t *testing.T, m *Manager, states ...State) Status {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st := m.Status()
		for _, s := range states {
			if st.State == s {
				return st
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("status stayed %+v, want one of %v", m.Status(), states)
	return Status{}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestDownloadInstallsTheNewProgram(t *testing.T) {
	tests := []struct {
		goos, goarch string
		archive      string
		build        func(*testing.T, []entry) []byte
		program      string
	}{
		{"linux", "amd64", "kiro-proxy-linux-x64.tar.gz", tarGz, "kiro-proxy-linux-x64/kiro-proxy"},
		{"darwin", "arm64", "kiro-proxy-macos-apple-silicon.tar.gz", tarGz, "kiro-proxy-macos-apple-silicon/kiro-proxy"},
		{"windows", "amd64", "kiro-proxy-windows-x64.zip", zipArchive, "kiro-proxy-windows-x64/kiro-proxy.exe"},
	}
	for _, tc := range tests {
		t.Run(tc.goos+"/"+tc.goarch, func(t *testing.T) {
			rel := &release{version: "3.6.0", archive: tc.archive}
			rel.data = tc.build(t, []entry{
				{name: strings.Split(tc.program, "/")[0] + "/LICENSE", body: "license"},
				{name: tc.program, body: "new program 3.6.0"},
			})
			srv := httptest.NewServer(rel)
			defer srv.Close()
			f := newFixture(t, tc.goos, tc.goarch, srv.URL)

			if st := f.m.Status(); !st.Supported || st.State != StateIdle || st.Path != f.exe {
				t.Fatalf("before: %+v", st)
			}
			started, err := f.m.Start("v3.6.0")
			if err != nil || !started {
				t.Fatalf("Start = %v, %v", started, err)
			}
			st := waitFor(t, f.m, StateReady, StateError)
			if st.State != StateReady || st.Version != "3.6.0" || st.Error != "" || st.Progress != nil {
				t.Fatalf("after: %+v", st)
			}
			if got := readFile(t, f.exe); got != "new program 3.6.0" {
				t.Fatalf("executable holds %q", got)
			}
			if got := readFile(t, f.exe+".old"); got != "old program" {
				t.Fatalf(".old holds %q", got)
			}
			if runtime.GOOS != "windows" {
				if info, err := os.Stat(f.exe); err != nil || info.Mode().Perm() != 0o755 {
					t.Fatalf("mode = %v, %v", info.Mode(), err)
				}
			}
			assertNoTemps(t, filepath.Dir(f.exe))

			// The dialog saw the download and its end, with progress.
			events := f.seen()
			var sawDownloading, sawFull bool
			for _, e := range events {
				if e.State == StateDownloading && e.Version == "3.6.0" {
					sawDownloading = true
					if e.Progress != nil && *e.Progress == 100 && e.Downloaded == int64(len(rel.data)) && e.Total == int64(len(rel.data)) {
						sawFull = true
					}
				}
			}
			if !sawDownloading || !sawFull || events[len(events)-1].State != StateReady {
				t.Fatalf("events = %+v", events)
			}
			for _, agent := range rel.agents {
				if agent != "kiro-proxy/3.5.8" {
					t.Fatalf("User-Agent = %q", agent)
				}
			}

			// The same version again is already done.
			if started, err := f.m.Start("3.6.0"); started || err != nil {
				t.Fatalf("Start again = %v, %v; want a no-op", started, err)
			}
		})
	}
}

// A second update before a restart replaces the first; .old keeps the program that is running.
func TestSecondUpdateKeepsTheRunningProgramAsBackup(t *testing.T) {
	mux := http.NewServeMux()
	for _, version := range []string{"3.6.0", "3.7.0"} {
		rel := &release{version: version, archive: "kiro-proxy-linux-x64.tar.gz"}
		rel.data = tarGz(t, []entry{{name: "kiro-proxy-linux-x64/kiro-proxy", body: "program " + version}})
		mux.Handle("/"+version+"/", rel)
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()
	f := newFixture(t, "linux", "amd64", srv.URL)

	for _, version := range []string{"3.6.0", "3.7.0"} {
		if _, err := f.m.Start(version); err != nil {
			t.Fatal(err)
		}
		if st := waitFor(t, f.m, StateReady, StateError); st.State != StateReady || st.Version != version {
			t.Fatalf("%s: %+v", version, st)
		}
	}
	if got := readFile(t, f.exe); got != "program 3.7.0" {
		t.Fatalf("executable holds %q", got)
	}
	if got := readFile(t, f.exe+".old"); got != "old program" {
		t.Fatalf(".old holds %q, want the program that is running", got)
	}
}

func TestDownloadFailures(t *testing.T) {
	tests := []struct {
		name    string
		sum     string // served in place of the archive's real checksum
		noSums  bool
		archive string // the only archive SHA256SUMS.txt lists
		want    string
		code    string
		detail  string
	}{
		{
			name: "checksum mismatch",
			sum:  strings.Repeat("1", 64),
			want: "The download does not match the release checksum.",
			code: FailChecksum,
		},
		{
			name:   "release not published yet",
			noSums: true,
			want:   "Version 3.6.0's release is not on GitHub yet; it may still be publishing. Try again in a few minutes.",
			code:   FailNotPublished,
		},
		{
			name:    "no checksum for this platform",
			archive: "kiro-proxy-linux-arm64.tar.gz",
			want:    "lists no checksum for kiro-proxy-linux-x64.tar.gz",
			code:    FailNoChecksum,
			detail:  "kiro-proxy-linux-x64.tar.gz",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rel := &release{version: "3.6.0", archive: tc.archive, sum: tc.sum, noSums: tc.noSums}
			if rel.archive == "" {
				rel.archive = "kiro-proxy-linux-x64.tar.gz"
			}
			rel.data = tarGz(t, []entry{{name: "kiro-proxy-linux-x64/kiro-proxy", body: "new program"}})
			srv := httptest.NewServer(rel)
			defer srv.Close()
			f := newFixture(t, "linux", "amd64", srv.URL)

			if _, err := f.m.Start("3.6.0"); err != nil {
				t.Fatal(err)
			}
			st := waitFor(t, f.m, StateReady, StateError)
			if st.State != StateError || st.Version != "3.6.0" || !strings.Contains(st.Error, tc.want) {
				t.Fatalf("status = %+v, want an error with %q", st, tc.want)
			}
			if st.ErrorCode != tc.code || st.ErrorDetail != tc.detail {
				t.Fatalf("errorCode, errorDetail = %q, %q; want %q, %q", st.ErrorCode, st.ErrorDetail, tc.code, tc.detail)
			}
			if got := readFile(t, f.exe); got != "old program" {
				t.Fatalf("executable holds %q; a failed update must not swap it", got)
			}
			if _, err := os.Stat(f.exe + ".old"); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf(".old exists after a failed update: %v", err)
			}
			assertNoTemps(t, filepath.Dir(f.exe))

			// A failed update may be tried again.
			if started, err := f.m.Start("3.6.0"); !started || err != nil {
				t.Fatalf("retry = %v, %v", started, err)
			}
			waitFor(t, f.m, StateReady, StateError)
		})
	}
}

func assertNoTemps(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), tempPrefix) {
			t.Fatalf("left %s behind", e.Name())
		}
	}
}

func TestStartRefusals(t *testing.T) {
	f := newFixture(t, "linux", "amd64", "http://127.0.0.1:1")
	tests := []struct {
		version string
		kind    error
	}{
		{"3.6", ErrVersion},
		{"three", ErrVersion},
		{"3.5.8", ErrVersion},
		{"3.4.9", ErrVersion},
	}
	for _, tc := range tests {
		started, err := f.m.Start(tc.version)
		if started || !errors.Is(err, tc.kind) {
			t.Errorf("Start(%q) = %v, %v; want %v", tc.version, started, err, tc.kind)
		}
	}
	if st := f.m.Status(); st.State != StateIdle {
		t.Fatalf("a refused start changed the status: %+v", st)
	}
	if _, ok := f.m.BeginRestart(); ok {
		t.Fatal("BeginRestart with nothing installed")
	}
}

func TestBusyWhileDownloading(t *testing.T) {
	hold := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hold
		http.NotFound(w, r)
	}))
	defer srv.Close()
	f := newFixture(t, "linux", "amd64", srv.URL)
	if _, err := f.m.Start("3.6.0"); err != nil {
		t.Fatal(err)
	}
	started, err := f.m.Start("3.7.0")
	close(hold)
	if started || !errors.Is(err, ErrBusy) {
		t.Fatalf("second Start = %v, %v; want ErrBusy", started, err)
	}
	waitFor(t, f.m, StateError)
}

func TestUnsupported(t *testing.T) {
	yes, no := true, false
	tempExe := func(t *testing.T) func() (string, error) {
		exe := filepath.Join(t.TempDir(), "kiro-proxy")
		if err := os.WriteFile(exe, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
		return func() (string, error) { return exe, nil }
	}
	tests := []struct {
		name   string
		opts   func(t *testing.T) Options
		reason string
	}{
		{"container", func(t *testing.T) Options {
			return Options{InContainer: &yes, Executable: tempExe(t), GOOS: "linux", GOARCH: "amd64"}
		}, ReasonContainer},
		{"no release for the platform", func(t *testing.T) Options {
			return Options{InContainer: &no, Executable: tempExe(t), GOOS: "freebsd", GOARCH: "amd64"}
		}, ReasonPlatform},
		{"executable unknown", func(t *testing.T) Options {
			return Options{InContainer: &no, Executable: func() (string, error) { return "", errors.New("no") }, GOOS: "linux", GOARCH: "amd64"}
		}, ReasonNotWritable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := tc.opts(t)
			opts.Version = "3.5.8"
			m := New(opts)
			st := m.Status()
			if st.Supported || st.Reason != tc.reason || st.State != StateIdle {
				t.Fatalf("status = %+v, want unsupported for %s", st, tc.reason)
			}
			if started, err := m.Start("3.6.0"); started || !errors.Is(err, ErrUnsupported) {
				t.Fatalf("Start = %v, %v; want ErrUnsupported", started, err)
			}
		})
	}
}

func TestUnsupportedWhenTheFolderIsReadOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a read-only folder still takes new files on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root writes to read-only folders")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "kiro-proxy")
	if err := os.WriteFile(exe, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o755)
	no := false
	m := New(Options{Version: "3.5.8", InContainer: &no, Executable: func() (string, error) { return exe, nil }, GOOS: "linux", GOARCH: "amd64"})
	st := m.Status()
	if st.Supported || st.Reason != ReasonNotWritable || st.Path != m.exe {
		t.Fatalf("status = %+v, want not_writable with the path", st)
	}
	// Fixing the permissions shows on the next look.
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(); !st.Supported || st.Reason != "" {
		t.Fatalf("after chmod: %+v", st)
	}
}

func TestStaleTempsAreRemoved(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "kiro-proxy")
	stale := filepath.Join(dir, tempPrefix+"stale")
	fresh := filepath.Join(dir, tempPrefix+"fresh")
	for _, p := range []string{exe, stale, fresh} {
		if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	no := false
	New(Options{Version: "3.5.8", InContainer: &no, Executable: func() (string, error) { return exe, nil }, GOOS: "linux", GOARCH: "amd64"})
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale temp file kept: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh temp file removed: %v", err)
	}
}

func TestHandoff(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".restart-sessions.json")

	if got := TakeHandoff(path, time.Minute); got != nil {
		t.Fatalf("no file, got %q", got)
	}

	if err := SaveHandoff(path, []byte("tokens")); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, %v; want 0600", info.Mode(), err)
		}
	}
	if got := TakeHandoff(path, time.Minute); string(got) != "tokens" {
		t.Fatalf("got %q", got)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("handoff kept after reading: %v", err)
	}

	// One left by a restart long ago is deleted unread.
	if err := SaveHandoff(path, []byte("old tokens")); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-3 * time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if got := TakeHandoff(path, 2*time.Minute); got != nil {
		t.Fatalf("stale handoff read: %q", got)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale handoff kept: %v", err)
	}
}
