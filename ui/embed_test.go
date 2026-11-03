package ui

import (
	"io/fs"
	"os"
	"testing"
)

func TestDistPlaceholderEmbedded(t *testing.T) {
	if _, err := os.Stat("dist/index.html"); err == nil {
		t.Skip("dist/index.html exists locally; this test covers the placeholder-only build")
	}

	dist, built := Dist()
	if built {
		t.Fatal("Dist() reported built with only the placeholder present")
	}
	if dist == nil {
		t.Fatal("Dist() returned a nil FS")
	}
	if _, err := fs.Stat(dist, ".keep"); err != nil {
		t.Fatalf("placeholder .keep not embedded at the dist root: %v", err)
	}
}
