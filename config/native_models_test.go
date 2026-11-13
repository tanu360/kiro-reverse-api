package config

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestNativeModelIDsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if ids, err := LoadNativeModelIDs(); err != nil || ids != nil {
		t.Fatalf("fresh db = (%v, %v), want (nil, nil)", ids, err)
	}

	want := []string{"claude-sonnet-4.5", "gpt-5.6-sol"}
	if err := SaveNativeModelIDs(want); err != nil {
		t.Fatalf("save: %v", err)
	}
	//! The row must survive a restart, which is what it exists for.
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if ids, err := LoadNativeModelIDs(); err != nil || !slices.Equal(ids, want) {
		t.Fatalf("after reload = (%v, %v), want %v", ids, err, want)
	}

	if err := SaveNativeModelIDs(nil); err != nil {
		t.Fatalf("save nil: %v", err)
	}
	if ids, err := LoadNativeModelIDs(); err != nil || len(ids) != 0 {
		t.Fatalf("after saving nil = (%v, %v), want empty", ids, err)
	}

	if err := setSetting(nativeModelsKey, "not json"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, err := LoadNativeModelIDs(); err == nil {
		t.Fatal("a corrupt row must report an error")
	}
}
