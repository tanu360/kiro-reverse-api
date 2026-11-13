package config

import (
	"path/filepath"
	"testing"
)

func TestPromptOverheadsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if data, err := LoadPromptOverheads(); err != nil || data != nil {
		t.Fatalf("fresh db = (%q, %v), want (nil, nil)", data, err)
	}
	want := `{"claude-haiku-4.5":[{"estimated":22,"overhead":4129}]}`
	if err := SavePromptOverheads([]byte(want)); err != nil {
		t.Fatalf("save: %v", err)
	}
	//! The row must survive a restart, which is what it exists for.
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if data, err := LoadPromptOverheads(); err != nil || string(data) != want {
		t.Fatalf("after reload = (%q, %v), want %q", data, err, want)
	}
}
