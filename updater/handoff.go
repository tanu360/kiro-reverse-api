package updater

import (
	"os"
	"time"
)

// SaveHandoff writes data for the process a restart runs next, such as the admin's sign-in
// tokens. The file is readable by this user only, since it holds secrets.
func SaveHandoff(path string, data []byte) error {
	// WriteFile sets the mode only on a new file.
	_ = os.Remove(path)
	return os.WriteFile(path, data, 0o600)
}

// TakeHandoff returns what SaveHandoff wrote if it was written within maxAge, and deletes the
// file either way: a handoff is used once, and one left by a restart long ago is never used.
func TakeHandoff(path string, maxAge time.Duration) []byte {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	defer os.Remove(path)
	if !info.Mode().IsRegular() || time.Since(info.ModTime()) > maxAge {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return data
}
