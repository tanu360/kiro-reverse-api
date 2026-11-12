package pool

import (
	"path/filepath"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func TestClearCooldownRemovesAndPersists(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	p := &AccountPool{
		cooldowns:   map[string]time.Time{"a": time.Now().Add(time.Hour), "b": time.Now().Add(time.Hour)},
		errorCounts: map[string]int{"a": 4},
		modelLists:  map[string]map[string]bool{},
	}
	if err := p.SaveCooldowns(); err != nil {
		t.Fatal(err)
	}
	var changed []string
	SetCooldownChangedHook(func(id string) { changed = append(changed, id) })
	t.Cleanup(func() { SetCooldownChangedHook(nil) })

	p.ClearCooldown("a")
	if !p.CooldownUntil("a").IsZero() || p.errorCounts["a"] != 0 {
		t.Fatalf("cooldown or error streak kept: %v %v", p.CooldownUntil("a"), p.errorCounts["a"])
	}
	if p.CooldownUntil("b").IsZero() {
		t.Fatal("another account's cooldown was cleared")
	}
	if len(changed) != 1 || changed[0] != "a" {
		t.Fatalf("hook calls = %v", changed)
	}
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := d.QueryRow(`SELECT COUNT(*) FROM cooldowns WHERE account_id='a'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("cooldown row for a still in the database")
	}
	if err := d.QueryRow(`SELECT COUNT(*) FROM cooldowns WHERE account_id='b'`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("b's row = %d, %v", rows, err)
	}

	// Nothing to clear: no write, no event.
	p.ClearCooldown("none")
	if len(changed) != 1 {
		t.Fatalf("hook ran for an account without a cooldown: %v", changed)
	}
}
