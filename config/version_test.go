package config

import (
	"encoding/json"
	"os"
	"testing"
)

// version.json is the update manifest the admin UI fetches from the main branch,
// while Version is compiled into the binary the operator runs. The UI compares
// one against the other, so a bump that touches only the manifest makes every
// running instance report an update that does not exist. Keep them equal here so
// the drift cannot reach main.
func TestVersionMatchesUpdateManifest(t *testing.T) {
	raw, err := os.ReadFile("../version.json")
	if err != nil {
		t.Fatalf("read version.json: %v", err)
	}

	var manifest struct {
		Version   string `json:"version"`
		Changelog string `json:"changelog"`
		Download  string `json:"download"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("parse version.json: %v", err)
	}

	if manifest.Version != Version {
		t.Fatalf("version.json says %q but config.Version is %q; every client running this build would be told to update",
			manifest.Version, Version)
	}
	if manifest.Changelog == "" {
		t.Error("version.json has no changelog; the update modal would render empty")
	}
	if manifest.Download == "" {
		t.Error("version.json has no download URL; the update modal would offer nowhere to go")
	}
}
