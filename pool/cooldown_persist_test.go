package pool

import (
	"path/filepath"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// A failure saves its cooldown in the background. WaitForBackgroundSaves
// returns only after every such save is written, so a test can then remove
// its data folder without a save writing a journal file into it.
func TestWaitForBackgroundSavesReturnsAfterTheSavesAreWritten(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(WaitForBackgroundSaves)
	p := newTestPool(config.Account{ID: "busy", Enabled: true}, config.Account{ID: "drained", Enabled: true})
	for range 10 {
		p.RecordThrottleError("busy", time.Minute)
		p.RecordQuotaError("drained", time.Hour)
	}

	WaitForBackgroundSaves()

	backgroundSavesMu.Lock()
	running := backgroundSavesRunning
	backgroundSavesMu.Unlock()
	if running != 0 {
		t.Fatalf("%d background saves still running after the wait", running)
	}
	d, err := db.Get()
	if err != nil {
		t.Fatalf("db.Get: %v", err)
	}
	var saved int
	if err := d.QueryRow(`SELECT COUNT(*) FROM cooldowns WHERE account_id IN ('busy', 'drained')`).Scan(&saved); err != nil {
		t.Fatalf("count cooldowns: %v", err)
	}
	if saved != 2 {
		t.Fatalf("%d cooldowns saved, want 2", saved)
	}
}

// With no save running, the wait returns at once.
func TestWaitForBackgroundSavesReturnsAtOnceWhenIdle(t *testing.T) {
	done := make(chan struct{})
	go func() {
		WaitForBackgroundSaves()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the wait blocked with no save running")
	}
}
