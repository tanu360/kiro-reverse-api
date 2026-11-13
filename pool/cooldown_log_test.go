package pool

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
)

// The start-up line reads "Loaded 1 active cooldown", not "1 active cooldowns".
func TestLoadedCooldownsLogCountsInPlainEnglish(t *testing.T) {
	WaitForBackgroundSaves()
	dir := t.TempDir()
	if err := db.ResetForTest(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	p := newTestPool(config.Account{ID: "one", AccessToken: "t"})
	p.mu.Lock()
	p.cooldowns["one"] = time.Now().Add(time.Hour)
	p.setKindLocked("one", CooldownError)
	p.mu.Unlock()
	if err := p.SaveCooldowns(); err != nil {
		t.Fatalf("save: %v", err)
	}

	var buf bytes.Buffer
	logger.SetOutput(&buf)
	t.Cleanup(func() { logger.SetOutput(os.Stderr) })
	if err := newTestPool().loadCooldowns(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "Loaded 1 active cooldown from the database") {
		t.Errorf("log %q, want \"Loaded 1 active cooldown from the database\"", out)
	}
}
