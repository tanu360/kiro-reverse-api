package proxy

import (
	"fmt"

	"kiro-proxy/config"
)

// Admin error codes for the image resize settings, with the same contract as the
// codes in admin_errors.go.
const (
	codeImageResizeDimensionRange = "image_resize_dimension_range"
	codeImageResizeSizeRange      = "image_resize_size_range"
)

// validateImageResizePatch returns the admin error code and message for an
// out-of-range image resize limit in a settings patch, or "" when both are absent
// or valid. It runs before anything is saved, so a bad patch never half-applies.
func validateImageResizePatch(maxDim, maxKB *int) (code, message string) {
	if maxDim != nil && (*maxDim < config.MinImageResizeMaxDimension || *maxDim > config.MaxImageResizeMaxDimension) {
		return codeImageResizeDimensionRange, fmt.Sprintf("imageResizeMaxDimension must be between %d and %d", config.MinImageResizeMaxDimension, config.MaxImageResizeMaxDimension)
	}
	if maxKB != nil && (*maxKB < config.MinImageResizeMaxKB || *maxKB > config.MaxImageResizeMaxKB) {
		return codeImageResizeSizeRange, fmt.Sprintf("imageResizeMaxKB must be between %d and %d", config.MinImageResizeMaxKB, config.MaxImageResizeMaxKB)
	}
	return "", ""
}

// applyImageResizePatch saves the image resize fields present in a settings patch.
// The getters are read on every request, so the change applies live.
func applyImageResizePatch(enabled *bool, maxDim, maxKB *int) error {
	if enabled != nil {
		if err := config.UpdateImageResize(*enabled); err != nil {
			return err
		}
	}
	if maxDim != nil {
		if err := config.UpdateImageResizeMaxDimension(*maxDim); err != nil {
			return err
		}
	}
	if maxKB != nil {
		if err := config.UpdateImageResizeMaxKB(*maxKB); err != nil {
			return err
		}
	}
	return nil
}
