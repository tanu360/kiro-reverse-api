// Package ui embeds the admin UI build so the Go binary serves it without files on disk.
package ui

import (
	"embed"
	"io/fs"
)

// dist/.keep is committed so this pattern always matches, even before `pnpm build` has run.
//
//go:embed all:dist
var distFS embed.FS

// Dist returns the admin UI build rooted at dist/ and whether index.html exists in it.
func Dist() (fs.FS, bool) {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return distFS, false
	}
	info, err := fs.Stat(sub, "index.html")
	if err != nil || !info.Mode().IsRegular() {
		return sub, false
	}
	return sub, true
}
