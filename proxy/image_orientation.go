package proxy

import (
	"encoding/binary"
	"image"
)

//! A re-encoded JPEG loses its EXIF block, so a phone photo stored sideways with an
//! orientation tag would reach the model sideways. The tag is applied to the pixels
//! before the image is re-encoded.

// jpegOrientation returns the EXIF orientation (1..8) of a JPEG, or 1 when it has
// none or the block cannot be read.
func jpegOrientation(raw []byte) int {
	if len(raw) < 4 || raw[0] != 0xFF || raw[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(raw); {
		if raw[i] != 0xFF {
			return 1
		}
		marker := raw[i+1]
		if marker == 0xFF { // fill byte
			i++
			continue
		}
		// Start of scan or end of image: the APPn segments are all before it.
		if marker == 0xDA || marker == 0xD9 {
			return 1
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			i += 2
			continue
		}
		size := int(binary.BigEndian.Uint16(raw[i+2 : i+4]))
		if size < 2 || i+2+size > len(raw) {
			return 1
		}
		segment := raw[i+4 : i+2+size]
		if marker == 0xE1 && len(segment) >= 6 && string(segment[:6]) == "Exif\x00\x00" {
			if o := exifOrientation(segment[6:]); o != 0 {
				return o
			}
			return 1
		}
		i += 2 + size
	}
	return 1
}

// exifOrientation reads tag 0x0112 from IFD0 of a TIFF block; 0 when absent.
func exifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 0
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return 0
	}
	ifd := int(order.Uint32(tiff[4:8]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 0
	}
	count := int(order.Uint16(tiff[ifd : ifd+2]))
	for n := 0; n < count; n++ {
		entry := ifd + 2 + n*12
		if entry+12 > len(tiff) {
			return 0
		}
		if order.Uint16(tiff[entry:entry+2]) != 0x0112 {
			continue
		}
		// Type SHORT, count 1: the value sits in the first two bytes of the value field.
		if order.Uint16(tiff[entry+2:entry+4]) != 3 {
			return 0
		}
		if o := int(order.Uint16(tiff[entry+8 : entry+10])); o >= 1 && o <= 8 {
			return o
		}
		return 0
	}
	return 0
}

// applyOrientation returns img turned upright for EXIF orientation o. Orientations
// 5..8 swap width and height.
func applyOrientation(img *image.RGBA, o int) *image.RGBA {
	if o < 2 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sx, sy int
			switch o {
			case 2: // mirror horizontal
				sx, sy = w-1-x, y
			case 3: // rotate 180
				sx, sy = w-1-x, h-1-y
			case 4: // mirror vertical
				sx, sy = x, h-1-y
			case 5: // transpose
				sx, sy = y, x
			case 6: // rotate 90 clockwise
				sx, sy = y, h-1-x
			case 7: // transverse
				sx, sy = w-1-y, h-1-x
			case 8: // rotate 90 counter-clockwise
				sx, sy = w-1-y, x
			}
			si := img.PixOffset(b.Min.X+sx, b.Min.Y+sy)
			di := dst.PixOffset(x, y)
			copy(dst.Pix[di:di+4], img.Pix[si:si+4])
		}
	}
	return dst
}
