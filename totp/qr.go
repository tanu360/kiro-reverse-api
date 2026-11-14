package totp

import (
	"fmt"
	"strings"

	"rsc.io/qr"
)

// quietZone is the blank border, in modules, that scanners need around a code.
const quietZone = 4

// QRSVG draws text as a QR code in a standalone SVG: black modules on white,
// one unit per module, so it scales sharply to any size.
func QRSVG(text string) (string, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	side := code.Size + 2*quietZone
	var path strings.Builder
	for y := 0; y < code.Size; y++ {
		for x := 0; x < code.Size; x++ {
			if !code.Black(x, y) {
				continue
			}
			//! One run per row keeps the path a few KB instead of one square per module.
			run := 1
			for x+run < code.Size && code.Black(x+run, y) {
				run++
			}
			fmt.Fprintf(&path, "M%d %dh%dv1h-%dz", x+quietZone, y+quietZone, run, run)
			x += run - 1
		}
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges"><rect width="%d" height="%d" fill="#fff"/><path fill="#000" d="%s"/></svg>`,
		side, side, side, side, path.String()), nil
}
