package proxy

import (
	"path/filepath"
	"testing"

	accountpool "kiro-proxy/pool"
)

// tempDataDir returns the test's temp folder for kiro.db. Before the folder
// is removed, its cleanup waits for the cooldown saves that the test's
// account failures started in the background. A save still running would
// write kiro.db-journal into the folder while it is being deleted, and the
// test would fail with "directory not empty".
func tempDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	//! t.TempDir registers its removal on the first call, so this cleanup always runs before it.
	t.Cleanup(accountpool.WaitForBackgroundSaves)
	return dir
}

// tempDBPath returns a kiro.db path in tempDataDir.
func tempDBPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(tempDataDir(t), "kiro.db")
}
