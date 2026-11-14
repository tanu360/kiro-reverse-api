package tunnel

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// helperSHA256 is the SHA-256 of this platform's uncompressed helper from the same release. The
// release build sets it with -ldflags "-X kiro-proxy/tunnel.helperSHA256=<hex>", so a downloaded
// helper is checked against a value inside this binary, not one fetched next to the download.
// A build from source leaves it empty and checks the release's SHA256SUMS.txt instead.
var helperSHA256 = ""

// DefaultReleaseBaseURL is where the release workflow uploads the helpers, one folder per tag.
const DefaultReleaseBaseURL = "https://github.com/tanu360/kiro-reverse-api/releases/download"

// binEnv names a helper to run instead of downloading one, as the Docker image does.
const binEnv = "KIRO_TUNNEL_BIN"

// maxDownloadBytes caps a compressed helper; the real one is under 10 MB.
const maxDownloadBytes = 100 << 20

// platformName is the release asset's platform, as .github/scripts/build-release.sh names it.
func platformName(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "linux/amd64":
		return "linux-x64", nil
	case "linux/arm64":
		return "linux-arm64", nil
	case "darwin/amd64":
		return "macos-intel", nil
	case "darwin/arm64":
		return "macos-apple-silicon", nil
	case "windows/amd64":
		return "windows-x64", nil
	case "windows/arm64":
		return "windows-arm64", nil
	}
	return "", fmt.Errorf("no Tailscale helper is published for %s/%s", goos, goarch)
}

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

// findBinary returns a helper that is already on disk: KIRO_TUNNEL_BIN, one next to the proxy's
// executable, or this version's earlier download if it still matches.
func (m *Manager) findBinary() (string, bool, error) {
	if m.opts.Binary != "" {
		return m.opts.Binary, true, nil
	}
	if path := os.Getenv(binEnv); path != "" {
		if _, err := os.Stat(path); err != nil {
			return "", false, fmt.Errorf("%s=%s: %w", binEnv, path, err)
		}
		return path, true, nil
	}
	if exe, err := os.Executable(); err == nil {
		path := filepath.Join(filepath.Dir(exe), "kiro-tunnel"+exeSuffix())
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, true, nil
		}
	}
	cached := m.cachedBinaryPath()
	if _, err := os.Stat(cached); err != nil {
		return "", false, nil
	}
	if helperSHA256 != "" {
		sum, err := fileSHA256(cached)
		if err != nil || sum != helperSHA256 {
			// Changed on disk since the download: fetch it again.
			_ = os.Remove(cached)
			return "", false, nil
		}
	}
	return cached, true, nil
}

func (m *Manager) cachedBinaryPath() string {
	return filepath.Join(m.opts.DataDir, "bin", "kiro-tunnel-"+m.opts.Version+exeSuffix())
}

// download fetches this version's helper for this platform, checks it, and saves it where
// findBinary looks. Older versions' helpers in the same folder are removed.
func (m *Manager) download(ctx context.Context) (string, error) {
	platform, err := platformName(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	base := strings.TrimSuffix(m.opts.ReleaseBaseURL, "/") + "/" + m.opts.Version + "/"
	asset := "kiro-tunnel-" + platform + ".gz"

	wantGz := ""
	if helperSHA256 == "" {
		wantGz, err = m.releaseChecksum(ctx, base+"SHA256SUMS.txt", asset)
		if err != nil {
			return "", err
		}
	}

	dir := filepath.Dir(m.cachedBinaryPath())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".kiro-tunnel-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	gzSum, err := m.fetchHelper(ctx, base+asset, tmp)
	if err != nil {
		return "", err
	}
	if wantGz != "" && gzSum != wantGz {
		return "", fmt.Errorf("the downloaded helper does not match the release checksum")
	}
	if helperSHA256 != "" {
		sum, err := fileSHA256(tmp.Name())
		if err != nil {
			return "", err
		}
		if sum != helperSHA256 {
			return "", fmt.Errorf("the downloaded helper does not match the checksum built into this version")
		}
	}
	if err := tmp.Chmod(0o755); err != nil && runtime.GOOS != "windows" {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	path := m.cachedBinaryPath()
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", err
	}
	removeOtherHelpers(dir, filepath.Base(path))
	return path, nil
}

// fetchHelper streams the gzip asset into out, uncompressed, and reports download progress.
// It returns the SHA-256 of the compressed bytes.
func (m *Manager) fetchHelper(ctx context.Context, url string, out io.Writer) (string, error) {
	resp, err := m.get(ctx, url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.ContentLength > maxDownloadBytes {
		return "", errors.New("the helper download is larger than expected")
	}

	hash := sha256.New()
	counted := &progressReader{
		r:     io.LimitReader(resp.Body, maxDownloadBytes+1),
		total: resp.ContentLength,
		report: func(pct int) {
			m.setProgress(pct)
		},
	}
	zr, err := gzip.NewReader(io.TeeReader(counted, hash))
	if err != nil {
		return "", fmt.Errorf("the helper download is not a gzip file: %w", err)
	}
	if _, err := io.Copy(out, io.LimitReader(zr, 4*maxDownloadBytes)); err != nil {
		return "", fmt.Errorf("download the helper: %w", err)
	}
	// Read to the end so the hash covers trailing bytes too.
	if _, err := io.Copy(io.Discard, io.TeeReader(counted, hash)); err != nil {
		return "", err
	}
	if counted.n > maxDownloadBytes {
		return "", errors.New("the helper download is larger than expected")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// releaseChecksum reads asset's line from the release's SHA256SUMS.txt.
func (m *Manager) releaseChecksum(ctx context.Context, url, asset string) (string, error) {
	resp, err := m.get(ctx, url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 1<<20))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == asset {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("the release lists no checksum for %s", asset)
}

func (m *Manager) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "kiro-proxy/"+m.opts.Version)
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download the Tailscale helper: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("release %s has no Tailscale helper for this platform (%s)", m.opts.Version, url)
		}
		return nil, fmt.Errorf("download the Tailscale helper: %s", resp.Status)
	}
	return resp, nil
}

type progressReader struct {
	r      io.Reader
	n      int64
	total  int64
	last   int
	report func(int)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.n += int64(n)
	if p.total > 0 {
		pct := int(p.n * 100 / p.total)
		if pct > 100 {
			pct = 100
		}
		if pct != p.last {
			p.last = pct
			p.report(pct)
		}
	}
	return n, err
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func removeOtherHelpers(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if name := e.Name(); name != keep && strings.HasPrefix(name, "kiro-tunnel-") {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
}
