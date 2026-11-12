package config

import "fmt"

const (
	DefaultImageResizeMaxDimension = 1568
	MinImageResizeMaxDimension     = 256
	MaxImageResizeMaxDimension     = 4096

	DefaultImageResizeMaxKB = 400
	MinImageResizeMaxKB     = 50
	MaxImageResizeMaxKB     = 4096
)

// GetImageResize reports whether inbound images over the size or dimension limit
// are downscaled and re-encoded before they go upstream. On by default: Kiro
// answers 400 to very large image fields such as pasted full-screen screenshots.
func GetImageResize() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.ImageResize == nil {
		return true
	}
	return *cfg.ImageResize
}

func UpdateImageResize(enabled bool) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.ImageResize = &enabled
	return Save()
}

// GetImageResizeMaxDimension returns the longest side, in pixels, an image may
// keep before it is downscaled.
func GetImageResizeMaxDimension() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.ImageResizeMaxDimension <= 0 {
		return DefaultImageResizeMaxDimension
	}
	return min(max(cfg.ImageResizeMaxDimension, MinImageResizeMaxDimension), MaxImageResizeMaxDimension)
}

func UpdateImageResizeMaxDimension(px int) error {
	if px < MinImageResizeMaxDimension || px > MaxImageResizeMaxDimension {
		return fmt.Errorf("imageResizeMaxDimension must be between %d and %d", MinImageResizeMaxDimension, MaxImageResizeMaxDimension)
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.ImageResizeMaxDimension = px
	return Save()
}

// GetImageResizeMaxKB returns the largest decoded image file, in KiB, sent as is.
func GetImageResizeMaxKB() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.ImageResizeMaxKB <= 0 {
		return DefaultImageResizeMaxKB
	}
	return min(max(cfg.ImageResizeMaxKB, MinImageResizeMaxKB), MaxImageResizeMaxKB)
}

func UpdateImageResizeMaxKB(kb int) error {
	if kb < MinImageResizeMaxKB || kb > MaxImageResizeMaxKB {
		return fmt.Errorf("imageResizeMaxKB must be between %d and %d", MinImageResizeMaxKB, MaxImageResizeMaxKB)
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.ImageResizeMaxKB = kb
	return Save()
}
