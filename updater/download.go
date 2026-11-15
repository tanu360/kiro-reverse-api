package updater

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

// maxDownloadBytes caps the release archive; the real ones are under 30 MB.
const maxDownloadBytes = 200 << 20

// maxBinaryBytes caps the program unpacked from it.
const maxBinaryBytes = 300 << 20

// platformName is the release asset's platform, as .github/scripts/build-release.sh names it.
func platformName(goos, goarch string) (string, bool) {
	switch goos + "/" + goarch {
	case "linux/amd64":
		return "linux-x64", true
	case "linux/arm64":
		return "linux-arm64", true
	case "darwin/amd64":
		return "macos-intel", true
	case "darwin/arm64":
		return "macos-apple-silicon", true
	case "windows/amd64":
		return "windows-x64", true
	case "windows/arm64":
		return "windows-arm64", true
	}
	return "", false
}

// install downloads version's archive next to the executable, checks it, unpacks the program
// and swaps it in. Every error it returns is a sentence for the user.
func (m *Manager) install(version string) error {
	ctx := context.Background()
	base := strings.TrimSuffix(m.opts.ReleaseBaseURL, "/") + "/" + version + "/"
	want, err := m.releaseChecksum(ctx, version, base+"SHA256SUMS.txt")
	if err != nil {
		return err
	}

	// Both files go in the executable's folder, so the final rename stays on one file system.
	dir := filepath.Dir(m.exe)
	archive, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return fmt.Errorf("Could not save the download next to the server's program: %w", err)
	}
	defer os.Remove(archive.Name())
	defer archive.Close()

	size, sum, err := m.fetch(ctx, version, base+m.archive, archive)
	if err != nil {
		return err
	}
	if sum != want {
		return errors.New("The download does not match the release checksum.")
	}
	m.opts.Logf("[Update] Version %s matches the release checksum", version)

	program, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return fmt.Errorf("Could not save the download next to the server's program: %w", err)
	}
	defer os.Remove(program.Name())
	defer program.Close()

	if err := extractBinary(archive, size, m.archive, m.binary, program); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		if err := program.Chmod(0o755); err != nil {
			return fmt.Errorf("Could not make the new program runnable: %w", err)
		}
	}
	// Windows cannot rename a file that is still open.
	if err := program.Close(); err != nil {
		return fmt.Errorf("Could not save the new program: %w", err)
	}
	_ = archive.Close()
	return m.swap(program.Name())
}

// swap puts the new program at the executable's path and keeps the running one as
// <exe>.old. Renaming a running program works on Linux, macOS and Windows alike.
func (m *Manager) swap(newPath string) error {
	exe := m.exe
	old := exe + ".old"
	m.mu.Lock()
	installed := m.installed
	m.mu.Unlock()
	if installed {
		// An earlier update already moved the running program to .old, which stays the backup;
		// the new download replaces the update that never ran.
		if err := os.Rename(newPath, exe); err != nil {
			return fmt.Errorf("Could not put the new program in place: %w", err)
		}
		return nil
	}
	if err := os.Remove(old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("Could not remove the previous backup %s: %w", old, err)
	}
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("Could not move the server's program aside: %w", err)
	}
	if err := os.Rename(newPath, exe); err != nil {
		if back := os.Rename(old, exe); back != nil {
			return fmt.Errorf("Could not put the new program in place (%v) nor the old one back (%v); the old program is at %s.", err, back, old)
		}
		return fmt.Errorf("Could not put the new program in place: %w", err)
	}
	m.mu.Lock()
	m.installed = true
	m.mu.Unlock()
	return nil
}

// releaseChecksum reads the archive's line from the release's SHA256SUMS.txt.
func (m *Manager) releaseChecksum(ctx context.Context, version, url string) (string, error) {
	resp, err := m.get(ctx, version, url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	sum, ok := findChecksum(io.LimitReader(resp.Body, 1<<20), m.archive)
	if !ok {
		return "", fmt.Errorf("Version %s's release lists no checksum for %s.", version, m.archive)
	}
	return sum, nil
}

// findChecksum finds asset in sha256sum output: "<hex>  <file>", or "<hex> *<file>" for a file
// summed in binary mode.
func findChecksum(r io.Reader, asset string) (string, bool) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || strings.TrimPrefix(fields[1], "*") != asset {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != sha256.Size*2 {
			return "", false
		}
		if _, err := hex.DecodeString(sum); err != nil {
			return "", false
		}
		return sum, true
	}
	return "", false
}

// fetch streams the archive into out with progress, and returns its size and SHA-256.
func (m *Manager) fetch(ctx context.Context, version, url string, out io.Writer) (int64, string, error) {
	resp, err := m.get(ctx, version, url)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.ContentLength > maxDownloadBytes {
		return 0, "", errors.New("The update download is larger than expected.")
	}

	logged := 0
	hash := sha256.New()
	counted := &progressReader{
		r:     io.LimitReader(resp.Body, maxDownloadBytes+1),
		total: resp.ContentLength,
		report: func(pct int, n, total int64) {
			m.setProgress(version, pct, n, total)
			if pct/25 > logged/25 {
				logged = pct
				m.opts.Logf("[Update] Version %s: %d%% of %d bytes downloaded", version, pct, total)
			}
		},
	}
	n, err := io.Copy(io.MultiWriter(out, hash), counted)
	if err != nil {
		return 0, "", fmt.Errorf("Could not download the update: %w", err)
	}
	if n > maxDownloadBytes {
		return 0, "", errors.New("The update download is larger than expected.")
	}
	return n, hex.EncodeToString(hash.Sum(nil)), nil
}

func (m *Manager) get(ctx context.Context, version, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("Could not download the update: %w", err)
	}
	req.Header.Set("User-Agent", "kiro-proxy/"+m.opts.Version)
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Could not download the update: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		m.opts.Logf("[Update] %s: %s", url, resp.Status)
		if resp.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("Version %s's release is not on GitHub yet; it may still be publishing. Try again in a few minutes.", version)
		}
		return nil, fmt.Errorf("GitHub answered %s to the update download.", resp.Status)
	}
	return resp, nil
}

// extractBinary copies the program named want out of the downloaded archive into out.
func extractBinary(f *os.File, size int64, archive, want string, out io.Writer) error {
	if strings.HasSuffix(archive, ".zip") {
		return extractZip(f, size, want, out)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("Could not read the download: %w", err)
	}
	return extractTarGz(f, want, out)
}

var errNoProgram = errors.New("The release archive does not hold the server's program.")

func extractTarGz(r io.Reader, want string, out io.Writer) error {
	zr, err := gzip.NewReader(r)
	if err != nil {
		return errors.New("The release archive is not a gzip file.")
	}
	tr := tar.NewReader(zr)
	found := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		// tar.ErrInsecurePath comes with a usable header when GODEBUG=tarinsecurepath=0; entryName
		// refuses those names below.
		if err != nil && !errors.Is(err, tar.ErrInsecurePath) {
			return fmt.Errorf("The release archive is damaged: %w", err)
		}
		name, ok := entryName(hdr.Name)
		if !ok {
			return unsafePath(hdr.Name)
		}
		if found || name != want || !hdr.FileInfo().Mode().IsRegular() {
			continue
		}
		if err := copyProgram(out, tr); err != nil {
			return err
		}
		found = true
	}
	if !found {
		return errNoProgram
	}
	return nil
}

func extractZip(r io.ReaderAt, size int64, want string, out io.Writer) error {
	zr, err := zip.NewReader(r, size)
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		return errors.New("The release archive is not a zip file.")
	}
	var match *zip.File
	for _, f := range zr.File {
		name, ok := entryName(f.Name)
		if !ok {
			return unsafePath(f.Name)
		}
		if match == nil && name == want && f.Mode().IsRegular() {
			match = f
		}
	}
	if match == nil {
		return errNoProgram
	}
	rc, err := match.Open()
	if err != nil {
		return fmt.Errorf("The release archive is damaged: %w", err)
	}
	defer rc.Close()
	return copyProgram(out, rc)
}

func unsafePath(name string) error {
	return fmt.Errorf("The release archive holds an unsafe path: %q.", name)
}

// entryName cleans an archive entry's name. An absolute name, or one that climbs out with "..",
// is refused: the release script writes neither, so such an archive is not one of ours.
func entryName(name string) (string, bool) {
	name = strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(name, "/") || (len(name) >= 2 && name[1] == ':') {
		return "", false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", false
		}
	}
	return path.Clean(name), true
}

func copyProgram(out io.Writer, r io.Reader) error {
	n, err := io.Copy(out, io.LimitReader(r, maxBinaryBytes+1))
	if err != nil {
		return fmt.Errorf("Could not unpack the update: %w", err)
	}
	if n > maxBinaryBytes {
		return errors.New("The program in the release archive is larger than expected.")
	}
	return nil
}

type progressReader struct {
	r      io.Reader
	n      int64
	total  int64
	last   int
	report func(pct int, n, total int64)
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
			p.report(pct, p.n, p.total)
		}
	}
	return n, err
}
