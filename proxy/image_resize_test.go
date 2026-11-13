package proxy

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
)

var testResizeLimits = imageResizeLimits{
	maxDim:   config.DefaultImageResizeMaxDimension,
	maxBytes: config.DefaultImageResizeMaxKB * 1024,
}

// setImageResizeForTest gives the test its own config with the given settings and
// puts the defaults back afterwards, so later tests see resizing on.
func setImageResizeForTest(t *testing.T, enabled bool, maxDim int) {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if !enabled {
		if err := config.UpdateImageResize(false); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = config.UpdateImageResize(true) })
	}
	if maxDim != config.DefaultImageResizeMaxDimension {
		if err := config.UpdateImageResizeMaxDimension(maxDim); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = config.UpdateImageResizeMaxDimension(config.DefaultImageResizeMaxDimension) })
	}
	imageResizeCache.reset()
	t.Cleanup(imageResizeCache.reset)
}

// useDefaultImageResizeForTest checks resizing is on with the default limits, which
// the translator tests rely on, and starts from an empty cache.
func useDefaultImageResizeForTest(t *testing.T) {
	t.Helper()
	if lim, on := currentImageResizeLimits(); !on || lim != testResizeLimits {
		t.Fatalf("image resize settings = %+v on=%v, want the defaults", lim, on)
	}
	imageResizeCache.reset()
	t.Cleanup(imageResizeCache.reset)
}

// resizeTestPhoto is an opaque gradient with seeded noise of the given amplitude:
// PNG cannot compress the noise away, JPEG mostly can.
func resizeTestPhoto(w, h int, seed int64, noise int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	rng := rand.New(rand.NewSource(seed))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := img.PixOffset(x, y)
			base := [3]int{x * 255 / w, y * 255 / h, (x + y) * 255 / (w + h)}
			for c := 0; c < 3; c++ {
				v := base[c]
				if noise > 0 {
					v += rng.Intn(2*noise+1) - noise
				}
				img.Pix[i+c] = uint8(min(max(v, 0), 255))
			}
			img.Pix[i+3] = 255
		}
	}
	return img
}

func encodeTestPNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func encodeTestJPEG(t *testing.T, img image.Image, quality int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func testKiroImage(format string, raw []byte) KiroImage {
	var img KiroImage
	img.Format = format
	img.Source.Bytes = base64.StdEncoding.EncodeToString(raw)
	return img
}

// decodeKiroImage decodes img's bytes and checks its format matches them.
func decodeKiroImage(t *testing.T, img KiroImage) (image.Image, int) {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(img.Source.Bytes)
	if err != nil {
		t.Fatalf("output is not standard base64: %v", err)
	}
	decoded, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("output does not decode: %v", err)
	}
	if format != img.Format {
		t.Fatalf("format field %q, bytes are %q", img.Format, format)
	}
	return decoded, len(raw)
}

var bigNoisyPNG = sync.OnceValue(func() []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, resizeTestPhoto(3000, 2000, 1, 24)); err != nil {
		panic(err)
	}
	return buf.Bytes()
})

// wideStripPNG is over the dimension limit but cheap to encode and resize.
func wideStripPNG(t *testing.T) []byte {
	t.Helper()
	return encodeTestPNG(t, resizeTestPhoto(2000, 200, 7, 0))
}

func TestImageResizeBigPNGBecomesJPEGWithinLimits(t *testing.T) {
	raw := bigNoisyPNG()
	if len(raw) <= testResizeLimits.maxBytes {
		t.Fatalf("fixture is only %d bytes; it must exceed the limit", len(raw))
	}
	img := testKiroImage("png", raw)
	if !resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("a 3000x2000 PNG over 400 KB was not resized")
	}
	out, n := decodeKiroImage(t, img)
	b := out.Bounds()
	if img.Format != "jpeg" {
		t.Fatalf("format = %q, want jpeg", img.Format)
	}
	if max(b.Dx(), b.Dy()) > testResizeLimits.maxDim {
		t.Fatalf("output %dx%d is over %d px", b.Dx(), b.Dy(), testResizeLimits.maxDim)
	}
	if d := b.Dx()*2 - b.Dy()*3; d < -3 || d > 3 {
		t.Fatalf("output %dx%d does not keep 3:2", b.Dx(), b.Dy())
	}
	t.Logf("%d KB PNG -> %dx%d jpeg %d KB", len(raw)>>10, b.Dx(), b.Dy(), n>>10)
	if n > testResizeLimits.maxBytes {
		t.Fatalf("output is %d bytes, over the %d limit", n, testResizeLimits.maxBytes)
	}
}

func TestImageResizeTransparentSmallPNGKept(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 2400, 1200))
	draw := func(r image.Rectangle, c color.NRGBA) {
		for y := r.Min.Y; y < r.Max.Y; y++ {
			for x := r.Min.X; x < r.Max.X; x++ {
				src.SetNRGBA(x, y, c)
			}
		}
	}
	draw(image.Rect(200, 200, 1000, 1000), color.NRGBA{R: 220, G: 40, B: 40, A: 255})
	draw(image.Rect(1400, 300, 2200, 900), color.NRGBA{R: 30, G: 90, B: 200, A: 255})
	img := testKiroImage("png", encodeTestPNG(t, src))

	if !resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("a 2400 px PNG was not resized")
	}
	out, n := decodeKiroImage(t, img)
	if img.Format != "png" {
		t.Fatalf("format = %q, want png for a transparent image that fits", img.Format)
	}
	if b := out.Bounds(); b.Dx() != 1568 || b.Dy() != 784 {
		t.Fatalf("output %dx%d, want 1568x784", b.Dx(), b.Dy())
	}
	if n > testResizeLimits.maxBytes {
		t.Fatalf("output is %d bytes, over the limit", n)
	}
	if _, _, _, a := out.At(5, 5).RGBA(); a != 0 {
		t.Fatalf("corner alpha = %d, want transparent", a)
	}
	if _, _, _, a := out.At(400, 400).RGBA(); a != 0xffff {
		t.Fatalf("shape alpha = %d, want opaque", a)
	}
}

func TestImageResizeTransparentNoisyPNGFlattensOnWhite(t *testing.T) {
	src := resizeTestPhoto(2000, 1500, 3, 60)
	for y := 0; y < 1500; y++ {
		for x := 0; x < 600; x++ {
			src.Pix[src.PixOffset(x, y)+3] = 0
		}
	}
	img := testKiroImage("png", encodeTestPNG(t, src))

	if !resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("not resized")
	}
	out, n := decodeKiroImage(t, img)
	if img.Format != "jpeg" {
		t.Fatalf("format = %q, want jpeg once the PNG does not fit", img.Format)
	}
	if n > testResizeLimits.maxBytes {
		t.Fatalf("output is %d bytes, over the limit", n)
	}
	r, g, b, _ := out.At(20, out.Bounds().Dy()/2).RGBA()
	if r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
		t.Fatalf("transparent area became (%d,%d,%d), want white", r>>8, g>>8, b>>8)
	}
}

func TestImageResizeTinyImageUntouched(t *testing.T) {
	img := testKiroImage("png", encodeTestPNG(t, resizeTestPhoto(64, 64, 4, 30)))
	before := img
	if resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("a 64x64 image was resized")
	}
	if img != before {
		t.Fatal("a 64x64 image changed")
	}
}

func TestImageResizeCorruptDataPassedThrough(t *testing.T) {
	blob := make([]byte, 600<<10)
	rand.New(rand.NewSource(5)).Read(blob)
	full := bigNoisyPNG()
	truncated := full[:len(full)/3]
	if !bytes.HasPrefix(truncated, []byte("\x89PNG")) {
		t.Fatal("fixture is not a PNG")
	}

	for name, raw := range map[string][]byte{"random blob": blob, "truncated png": truncated} {
		img := testKiroImage("png", raw)
		before := img
		if resizeKiroImage(&img, testResizeLimits) || img != before {
			t.Fatalf("%s: corrupt image changed", name)
		}
	}
	img := KiroImage{Format: "png"}
	img.Source.Bytes = "not base64 at all!"
	if resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("invalid base64 changed")
	}
}

func TestImageResizeNeverUpscales(t *testing.T) {
	raw := encodeTestJPEG(t, resizeTestPhoto(800, 600, 8, 90), 100)
	if len(raw) <= testResizeLimits.maxBytes {
		t.Fatalf("fixture is only %d bytes; it must exceed the limit", len(raw))
	}
	img := testKiroImage("jpeg", raw)
	if !resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("an 800x600 JPEG over 400 KB was not re-encoded")
	}
	out, n := decodeKiroImage(t, img)
	if b := out.Bounds(); b.Dx() > 800 || b.Dy() > 600 {
		t.Fatalf("output %dx%d is bigger than the 800x600 source", b.Dx(), b.Dy())
	}
	if n > testResizeLimits.maxBytes {
		t.Fatalf("output is %d bytes, over the limit", n)
	}

	if w, h := fitWithin(800, 600, 1568); w != 800 || h != 600 {
		t.Fatalf("fitWithin upscaled to %dx%d", w, h)
	}
	if w, h := fitWithin(5000, 2, 1568); w != 1568 || h != 1 {
		t.Fatalf("fitWithin(5000x2) = %dx%d, want 1568x1", w, h)
	}
}

// gopher-doc.1bpp.lossless.webp from golang.org/x/image/testdata (75x100, BSD licence).
const testWebPGopher = "UklGRrIBAABXRUJQVlA4TKUBAAAvSsAYAA8w//M///MfeJAkbXvaSG7m8Q3GfYSBJekwQztm/IcZlgwnmWImn2BK7aFmBtnVir6q//8VOkFE/xm4baTIu8c48ArEo6+B3zFKYln3pqClSCKX0begFTAXFOLXHSyF8cCNcZEG4OywuA4KVVfJCiArU7GAgJI8+lJP/OKMT/fBAjevg1cYB7YVkFuWga2lyPi5I0HFy5YTpWIHg0RZpkniRVW9odHAKOwosWuOGdxIyn2OvaCDvhg/we6TwadPBPbqBV58MsLmMJ8yZnOWk8SRz4N+QoyPL+MnamzMvcE1rHNEr91F9GKZPVUcS9w7PhhH36suB9qPeYb/oLk6cuTiJ0wOK3m5h1cKjW6EVZCYMK7dxcKCBdgP9HkKr9gkAO2P8GKZGWVdIAatQa+1IDpt6qyorVwdy01xdW8Jkfk6xjEXmVQQ+HQdFr6OKhIN34dXWq0+0qr6EJSCeeVLH9+gvGTLyqM65PQ44ihzlTXxQKjKbAvshXgir7Lil9w4L2bvMycmjQcqXaMCO6BlY28i+FOLzbfI1vEqxAhotocAAA=="

func TestImageResizeDecodesGIFAndWebP(t *testing.T) {
	red := color.RGBA{R: 255, A: 255}
	blue := color.RGBA{B: 255, A: 255}
	palette := color.Palette{red, blue}
	frame := func(index uint8) *image.Paletted {
		p := image.NewPaletted(image.Rect(0, 0, 2000, 1000), palette)
		for i := range p.Pix {
			p.Pix[i] = index
		}
		return p
	}
	var anim bytes.Buffer
	if err := gif.EncodeAll(&anim, &gif.GIF{Image: []*image.Paletted{frame(0), frame(1)}, Delay: []int{10, 10}}); err != nil {
		t.Fatal(err)
	}
	img := testKiroImage("gif", anim.Bytes())
	if !resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("a 2000 px GIF was not resized")
	}
	out, _ := decodeKiroImage(t, img)
	if b := out.Bounds(); b.Dx() != 1568 || b.Dy() != 784 {
		t.Fatalf("gif output %dx%d, want 1568x784", b.Dx(), b.Dy())
	}
	if r, _, b, _ := out.At(700, 400).RGBA(); r>>8 < 200 || b>>8 > 60 {
		t.Fatalf("gif output is not the first (red) frame: r=%d b=%d", r>>8, b>>8)
	}

	webp := KiroImage{Format: "webp"}
	webp.Source.Bytes = testWebPGopher
	if !resizeKiroImage(&webp, imageResizeLimits{maxDim: 16, maxBytes: testResizeLimits.maxBytes}) {
		t.Fatal("a 75x100 webp over a 16 px limit was not resized")
	}
	out, _ = decodeKiroImage(t, webp)
	if b := out.Bounds(); b.Dx() != 12 || b.Dy() != 16 {
		t.Fatalf("webp output %dx%d, want 12x16", b.Dx(), b.Dy())
	}
}

// withExifOrientation inserts an APP1 Exif segment holding only the orientation
// tag right after the JPEG's SOI marker.
func withExifOrientation(jpg []byte, orientation uint16, order binary.ByteOrder) []byte {
	tiff := make([]byte, 8+2+12+4)
	if order == binary.LittleEndian {
		copy(tiff, "II")
	} else {
		copy(tiff, "MM")
	}
	order.PutUint16(tiff[2:], 42)
	order.PutUint32(tiff[4:], 8)
	order.PutUint16(tiff[8:], 1)
	order.PutUint16(tiff[10:], 0x0112)
	order.PutUint16(tiff[12:], 3)
	order.PutUint32(tiff[14:], 1)
	order.PutUint16(tiff[18:], orientation)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	segment := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:], uint16(len(payload)+2))
	segment = append(segment, payload...)
	out := append([]byte{}, jpg[:2]...)
	out = append(out, segment...)
	return append(out, jpg[2:]...)
}

func TestImageResizeAppliesExifOrientation(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2000, 1000))
	for y := 0; y < 1000; y++ {
		for x := 0; x < 2000; x++ {
			c := color.RGBA{R: 230, G: 20, B: 20, A: 255} // left half red
			if x >= 1000 {
				c = color.RGBA{R: 20, G: 20, B: 230, A: 255} // right half blue
			}
			src.SetRGBA(x, y, c)
		}
	}
	base := encodeTestJPEG(t, src, 90)
	for _, order := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
		raw := withExifOrientation(base, 6, order)
		if got := jpegOrientation(raw); got != 6 {
			t.Fatalf("%v: jpegOrientation = %d, want 6", order, got)
		}
		img := testKiroImage("jpeg", raw)
		if !resizeKiroImage(&img, testResizeLimits) {
			t.Fatal("not resized")
		}
		out, _ := decodeKiroImage(t, img)
		b := out.Bounds()
		if b.Dx() != 784 || b.Dy() != 1568 {
			t.Fatalf("%v: output %dx%d, want 784x1568 (turned upright)", order, b.Dx(), b.Dy())
		}
		// Turned 90 degrees clockwise, the left (red) half is on top.
		if r, _, bl, _ := out.At(392, 100).RGBA(); r>>8 < 180 || bl>>8 > 80 {
			t.Fatalf("%v: top is not red: r=%d b=%d", order, r>>8, bl>>8)
		}
		if r, _, bl, _ := out.At(392, 1450).RGBA(); bl>>8 < 180 || r>>8 > 80 {
			t.Fatalf("%v: bottom is not blue: r=%d b=%d", order, r>>8, bl>>8)
		}
	}
	if got := jpegOrientation(base); got != 1 {
		t.Fatalf("no Exif: orientation = %d, want 1", got)
	}
}

func TestApplyOrientationAllTags(t *testing.T) {
	// 3x2 source, pixel value = index, so every mapping is checked exactly.
	src := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for i := 0; i < 6; i++ {
		src.Pix[i*4] = uint8(i)
	}
	want := map[int][]uint8{
		1: {0, 1, 2, 3, 4, 5},
		2: {2, 1, 0, 5, 4, 3},
		3: {5, 4, 3, 2, 1, 0},
		4: {3, 4, 5, 0, 1, 2},
		5: {0, 3, 1, 4, 2, 5},
		6: {3, 0, 4, 1, 5, 2},
		7: {5, 2, 4, 1, 3, 0},
		8: {2, 5, 1, 4, 0, 3},
	}
	for o, pix := range want {
		out := applyOrientation(src, o)
		var got []uint8
		for i := 0; i < len(out.Pix); i += 4 {
			got = append(got, out.Pix[i])
		}
		if string(got) != string(pix) {
			t.Fatalf("orientation %d: got %v, want %v", o, got, pix)
		}
	}
}

func TestImageResizeURLSafeBase64Input(t *testing.T) {
	raw := encodeTestJPEG(t, resizeTestPhoto(2000, 300, 9, 10), 90)
	for _, enc := range []*base64.Encoding{base64.URLEncoding, base64.RawURLEncoding, base64.RawStdEncoding} {
		img := KiroImage{Format: "jpeg"}
		img.Source.Bytes = enc.EncodeToString(raw)
		if enc == base64.URLEncoding && !strings.ContainsAny(img.Source.Bytes, "-_") {
			t.Fatal("fixture has no URL-safe characters")
		}
		if !resizeKiroImage(&img, testResizeLimits) {
			t.Fatalf("%v input was not resized", enc)
		}
		out, _ := decodeKiroImage(t, img)
		if b := out.Bounds(); b.Dx() != 1568 {
			t.Fatalf("output width %d, want 1568", b.Dx())
		}
	}
}

func TestImageResizeCacheReusesResult(t *testing.T) {
	imageResizeCache.reset()
	t.Cleanup(imageResizeCache.reset)
	raw := wideStripPNG(t)
	first := testKiroImage("png", raw)
	second := first

	before := resizeDecodes.Load()
	if !resizeKiroImage(&first, testResizeLimits) || !resizeKiroImage(&second, testResizeLimits) {
		t.Fatal("not resized")
	}
	if got := resizeDecodes.Load() - before; got != 1 {
		t.Fatalf("decoded %d times, want once", got)
	}
	if first != second {
		t.Fatal("the cached result differs from the first")
	}

	// Other limits are another cache entry.
	third := testKiroImage("png", raw)
	if !resizeKiroImage(&third, imageResizeLimits{maxDim: 800, maxBytes: testResizeLimits.maxBytes}) {
		t.Fatal("not resized at 800 px")
	}
	if got := resizeDecodes.Load() - before; got != 2 {
		t.Fatalf("decoded %d times after a limit change, want twice", got)
	}
	if out, _ := decodeKiroImage(t, third); out.Bounds().Dx() != 800 {
		t.Fatalf("width %d, want 800", out.Bounds().Dx())
	}
}

func TestImageResizeLRUEvictsOldest(t *testing.T) {
	c := newResizeLRU(2)
	key := func(b byte) resizeCacheKey { return resizeCacheKey{sum: [32]byte{b}} }
	c.put(key(1), resizeCacheEntry{format: "a"})
	c.put(key(2), resizeCacheEntry{format: "b"})
	c.get(key(1))
	c.put(key(3), resizeCacheEntry{format: "c"})
	if _, ok := c.get(key(2)); ok {
		t.Fatal("least recently used entry was kept")
	}
	for _, k := range []byte{1, 3} {
		if _, ok := c.get(key(k)); !ok {
			t.Fatalf("entry %d was evicted", k)
		}
	}
}

// pngHeaderOnly is a PNG signature and IHDR with no pixel data: DecodeConfig reads
// it and a full decode fails. It stands in for images too big to build in a test.
func pngHeaderOnly(w, h int, bitDepth, colorType byte) []byte {
	chunk := []byte("IHDR")
	chunk = binary.BigEndian.AppendUint32(chunk, uint32(w))
	chunk = binary.BigEndian.AppendUint32(chunk, uint32(h))
	chunk = append(chunk, bitDepth, colorType, 0, 0, 0)
	out := []byte("\x89PNG\r\n\x1a\n")
	out = binary.BigEndian.AppendUint32(out, 13)
	out = append(out, chunk...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(chunk))
}

func TestImageResizeDecodeCostCountsBitDepthAndScaler(t *testing.T) {
	cost := func(raw []byte) int64 {
		t.Helper()
		c, ok := resizeDecodeCost(raw, testResizeLimits)
		if !ok {
			t.Fatal("resizeDecodeCost refused a small image")
		}
		return c
	}
	// 2000x1000 fits in 1568x784: decoded source + scaler buffer (1568 x 1000 x 32 B)
	// + three 1568x784 RGBA copies.
	const scaler, outputs = 1568 * 1000 * 32, 1568 * 784 * 4 * 3
	if got, want := cost(pngHeaderOnly(2000, 1000, 8, 2)), int64(2000*1000*4+scaler+outputs); got != want {
		t.Fatalf("8-bit RGB cost = %d, want %d", got, want)
	}
	for _, colorType := range []byte{0, 2, 6} { // Gray16, RGB64, NRGBA64
		if got, want := cost(pngHeaderOnly(2000, 1000, 16, colorType)), int64(2000*1000*8+scaler+outputs); got != want {
			t.Fatalf("16-bit colour type %d cost = %d, want %d (8 B/px)", colorType, got, want)
		}
	}

	baseline := encodeTestJPEG(t, image.NewGray(image.Rect(0, 0, 64, 64)), 80)
	sof := bytes.Index(baseline, []byte{0xFF, 0xC0})
	if sof < 0 {
		t.Fatal("no SOF0 marker in the test JPEG")
	}
	progressive := bytes.Clone(baseline)
	progressive[sof+1] = 0xC2
	if jpegProgressive(baseline) || !jpegProgressive(progressive) {
		t.Fatal("jpegProgressive misread SOF0/SOF2")
	}
	if diff := cost(progressive) - cost(baseline); diff != 64*64*12 {
		t.Fatalf("progressive JPEG costs %d more, want %d (16 vs 4 B/px)", diff, 64*64*12)
	}
}

func TestImageResizeOverMemoryBudgetLeftAsIs(t *testing.T) {
	imageResizeCache.reset()
	t.Cleanup(imageResizeCache.reset)

	// 6300x6300 (39.7 MP) is under the pixel cap. 8-bit needs ~481 MiB, under the
	// budget, so it is decoded (and fails: no pixel data). 16-bit needs ~632 MiB.
	for _, tc := range []struct {
		bitDepth byte
		decodes  int64
	}{{8, 1}, {16, 0}} {
		img := testKiroImage("png", pngHeaderOnly(6300, 6300, tc.bitDepth, 2))
		before := img
		start := resizeDecodes.Load()
		if resizeKiroImage(&img, testResizeLimits) || img != before {
			t.Fatalf("%d-bit header-only PNG changed", tc.bitDepth)
		}
		if got := resizeDecodes.Load() - start; got != tc.decodes {
			t.Fatalf("%d-bit 6300x6300: %d full decodes, want %d", tc.bitDepth, got, tc.decodes)
		}
	}
}

func TestImageResizeCapsFullDecodesPerPayload(t *testing.T) {
	useDefaultImageResizeForTest(t)
	strip := func(i int) KiroImage {
		return testKiroImage("png", encodeTestPNG(t, resizeTestPhoto(2000+i, 200, 7, 0)))
	}
	payload := &KiroPayload{}
	cur := &payload.ConversationState.CurrentMessage.UserInputMessage
	for i := 0; i <= resizeMaxDecodesPerPayload; i++ {
		cur.Images = append(cur.Images, strip(i))
	}
	last := cur.Images[resizeMaxDecodesPerPayload]

	resizePayloadImages(payload)

	for i, img := range cur.Images[:resizeMaxDecodesPerPayload] {
		if img.Format != "jpeg" {
			t.Fatalf("image %d not resized", i)
		}
	}
	if cur.Images[resizeMaxDecodesPerPayload] != last {
		t.Fatal("the image past the per-request decode cap was resized")
	}

	// The skipped image was not cached as unchanged: the next request resizes it.
	next := &KiroPayload{}
	next.ConversationState.CurrentMessage.UserInputMessage.Images = []KiroImage{last}
	resizePayloadImages(next)
	if next.ConversationState.CurrentMessage.UserInputMessage.Images[0].Format != "jpeg" {
		t.Fatal("the image skipped for the cap was not resized by the next request")
	}

	// Cache hits do not count against the cap.
	many := &KiroPayload{}
	same := strip(0)
	for i := 0; i <= resizeMaxDecodesPerPayload; i++ {
		many.ConversationState.CurrentMessage.UserInputMessage.Images = append(many.ConversationState.CurrentMessage.UserInputMessage.Images, same)
	}
	resizePayloadImages(many)
	for i, img := range many.ConversationState.CurrentMessage.UserInputMessage.Images {
		if img.Format != "jpeg" {
			t.Fatalf("repeated image %d not resized from the cache", i)
		}
	}
}

func TestMemoryBudgetBoundsWait(t *testing.T) {
	b := newMemoryBudget(100)
	if !b.acquire(60, 0) {
		t.Fatal("first acquire failed")
	}
	if b.acquire(60, 10*time.Millisecond) {
		t.Fatal("acquired past the budget")
	}
	got := make(chan bool)
	go func() { got <- b.acquire(60, 5*time.Second) }()
	time.Sleep(10 * time.Millisecond)
	b.release(60)
	if !<-got {
		t.Fatal("a waiter was not woken by release")
	}
}

func TestImageResizeLeavesImageWhenBudgetStaysFull(t *testing.T) {
	imageResizeCache.reset()
	t.Cleanup(imageResizeCache.reset)
	wait := resizeBudgetWait
	resizeBudgetWait = 20 * time.Millisecond
	t.Cleanup(func() { resizeBudgetWait = wait })

	if !resizeBudget.acquire(resizeMemoryBudget, 0) {
		t.Fatal("the resize budget is not free")
	}
	img := testKiroImage("png", wideStripPNG(t))
	before := img
	changed := resizeKiroImage(&img, testResizeLimits)
	resizeBudget.release(resizeMemoryBudget)
	if changed || img != before {
		t.Fatal("resized without the memory budget")
	}

	// Not cached as unchanged: with the budget free it is resized.
	if !resizeKiroImage(&img, testResizeLimits) {
		t.Fatal("not resized once the budget was free")
	}
}

func TestImageResizeBudgetWaitIsPerPayload(t *testing.T) {
	useDefaultImageResizeForTest(t)
	imageResizeCache.reset()
	t.Cleanup(imageResizeCache.reset)
	wait := resizeBudgetWait
	resizeBudgetWait = 150 * time.Millisecond
	t.Cleanup(func() { resizeBudgetWait = wait })

	if !resizeBudget.acquire(resizeMemoryBudget, 0) {
		t.Fatal("the resize budget is not free")
	}
	defer resizeBudget.release(resizeMemoryBudget)
	payload := &KiroPayload{}
	cur := &payload.ConversationState.CurrentMessage.UserInputMessage
	for i := 0; i < 3; i++ {
		cur.Images = append(cur.Images, testKiroImage("png", encodeTestPNG(t, resizeTestPhoto(2000+i, 200, 7, 0))))
	}
	before := append([]KiroImage(nil), cur.Images...)

	start := time.Now()
	resizePayloadImages(payload)
	//! Three images each waiting the full 150 ms would take 450 ms.
	if took := time.Since(start); took > 300*time.Millisecond {
		t.Fatalf("resizePayloadImages took %s with the budget full, want about one wait (%s)", took, resizeBudgetWait)
	}
	for i := range cur.Images {
		if cur.Images[i] != before[i] {
			t.Fatalf("image %d changed without the memory budget", i)
		}
	}
}

func TestImageResizeDisabledLeavesImages(t *testing.T) {
	setImageResizeForTest(t, false, config.DefaultImageResizeMaxDimension)
	payload := &KiroPayload{}
	payload.ConversationState.CurrentMessage.UserInputMessage.Images = []KiroImage{testKiroImage("png", wideStripPNG(t))}
	before := payload.ConversationState.CurrentMessage.UserInputMessage.Images[0]

	resizePayloadImages(payload)

	if payload.ConversationState.CurrentMessage.UserInputMessage.Images[0] != before {
		t.Fatal("an image changed with resizing off")
	}
	if got := estimateImageDataTokens(before.Source.Bytes); got != 534 {
		t.Fatalf("estimate with resizing off = %d, want 534 (2000x200)", got)
	}
}

func claudeImageBlock(raw []byte) map[string]interface{} {
	return map[string]interface{}{
		"type": "image",
		"source": map[string]interface{}{
			"type":       "base64",
			"media_type": "image/png",
			"data":       base64.StdEncoding.EncodeToString(raw),
		},
	}
}

func requireResizedJPEG(t *testing.T, where string, img KiroImage) {
	t.Helper()
	if img.Format != "jpeg" {
		t.Fatalf("%s: format %q, want jpeg", where, img.Format)
	}
	out, _ := decodeKiroImage(t, img)
	if b := out.Bounds(); b.Dx() != 1568 || b.Dy() != 157 {
		t.Fatalf("%s: %dx%d, want 1568x157", where, b.Dx(), b.Dy())
	}
}

func TestClaudeToKiroResizesCurrentAndToolResultImages(t *testing.T) {
	useDefaultImageResizeForTest(t)
	raw := wideStripPNG(t)
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 100, Messages: []ClaudeMessage{
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "text", "text": "look"},
			claudeImageBlock(raw),
		}},
		{Role: "assistant", Content: []interface{}{
			map[string]interface{}{"type": "tool_use", "id": "toolu_1", "name": "screenshot", "input": map[string]interface{}{}},
		}},
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "tool_result", "tool_use_id": "toolu_1", "content": []interface{}{claudeImageBlock(raw)}},
			claudeImageBlock(raw),
		}},
	}}

	payload := ClaudeToKiro(req, false)

	current := payload.ConversationState.CurrentMessage.UserInputMessage.Images
	if len(current) != 2 {
		t.Fatalf("current images = %d, want 2", len(current))
	}
	for i, img := range current {
		requireResizedJPEG(t, "current image "+string(rune('0'+i)), img)
	}
	var history []KiroImage
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage != nil {
			history = append(history, h.UserInputMessage.Images...)
		}
	}
	if len(history) != 1 {
		t.Fatalf("history images = %d, want 1", len(history))
	}
	requireResizedJPEG(t, "history image", history[0])
}

func TestOpenAIToKiroResizesImageURL(t *testing.T) {
	useDefaultImageResizeForTest(t)
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(wideStripPNG(t))
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-sonnet-4.5", Messages: []OpenAIMessage{openAIImageTurn("what is this", url)}}, false)

	images := payload.ConversationState.CurrentMessage.UserInputMessage.Images
	if len(images) != 1 {
		t.Fatalf("images = %d, want 1", len(images))
	}
	requireResizedJPEG(t, "image_url", images[0])
}

func TestResponsesInputImageResized(t *testing.T) {
	useDefaultImageResizeForTest(t)
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(wideStripPNG(t))
	input, _ := json.Marshal([]interface{}{map[string]interface{}{
		"role": "user",
		"content": []interface{}{
			map[string]interface{}{"type": "input_text", "text": "describe"},
			map[string]interface{}{"type": "input_image", "image_url": url},
		},
	}})
	prepared, msg := prepareResponsesRequest(&OpenAIResponsesRequest{Model: "claude-sonnet-4.5", Input: input}, nil)
	if prepared == nil {
		t.Fatalf("prepareResponsesRequest: %s", msg)
	}
	payload := OpenAIToKiro(&prepared.OpenAIRequest, false)

	images := payload.ConversationState.CurrentMessage.UserInputMessage.Images
	if len(images) != 1 {
		t.Fatalf("images = %d, want 1", len(images))
	}
	requireResizedJPEG(t, "input_image", images[0])
}

func TestResizeSkipsHistoryImagesBeyondBudgetCount(t *testing.T) {
	useDefaultImageResizeForTest(t)
	original := testKiroImage("png", wideStripPNG(t))
	payload := &KiroPayload{}
	for i := 0; i < maxHistoryImages+1; i++ {
		payload.ConversationState.History = append(payload.ConversationState.History,
			KiroHistoryMessage{UserInputMessage: &KiroUserInputMessage{Content: "shot", Images: []KiroImage{original}}},
			KiroHistoryMessage{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: "seen"}},
		)
	}

	resizePayloadImages(payload)

	for i, h := range payload.ConversationState.History {
		if h.UserInputMessage == nil {
			continue
		}
		img := h.UserInputMessage.Images[0]
		if i == 0 {
			if img != original {
				t.Fatal("the oldest history image, which limitHistoryImages drops, was processed")
			}
			continue
		}
		requireResizedJPEG(t, "history image", img)
	}
}

func TestEstimateImageTokensUsesResizeMaxDimension(t *testing.T) {
	setImageResizeForTest(t, true, 500)
	data := base64.StdEncoding.EncodeToString(encodeTestPNG(t, image.NewGray(image.Rect(0, 0, 1000, 1000))))
	if got := estimateImageDataTokens(data); got != 334 {
		t.Fatalf("1000x1000 at max 500 px = %d tokens, want 334 (500x500/750)", got)
	}
}

func TestImageResizeSettingsRoundTrip(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(func() {
		_ = config.UpdateImageResize(true)
		_ = config.UpdateImageResizeMaxDimension(config.DefaultImageResizeMaxDimension)
		_ = config.UpdateImageResizeMaxKB(config.DefaultImageResizeMaxKB)
	})
	h := &Handler{}
	get := func() map[string]interface{} {
		rec := httptest.NewRecorder()
		h.apiGetSettings(rec, httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil))
		var got map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return got
	}
	if got := get(); got["imageResize"] != true || got["imageResizeMaxDimension"] != float64(1568) || got["imageResizeMaxKB"] != float64(400) {
		t.Fatalf("defaults = %v %v %v", got["imageResize"], got["imageResizeMaxDimension"], got["imageResizeMaxKB"])
	}

	rec := httptest.NewRecorder()
	h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(`{"imageResize":false,"imageResizeMaxDimension":1024,"imageResizeMaxKB":300}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := get(); got["imageResize"] != false || got["imageResizeMaxDimension"] != float64(1024) || got["imageResizeMaxKB"] != float64(300) {
		t.Fatalf("saved = %v %v %v", got["imageResize"], got["imageResizeMaxDimension"], got["imageResizeMaxKB"])
	}
	if _, on := currentImageResizeLimits(); on {
		t.Fatal("the switch did not apply live")
	}

	for _, tc := range []struct{ body, code string }{
		{`{"imageResizeMaxDimension":255}`, codeImageResizeDimensionRange},
		{`{"imageResizeMaxDimension":4097}`, codeImageResizeDimensionRange},
		{`{"imageResizeMaxKB":49}`, codeImageResizeSizeRange},
		{`{"imageResizeMaxKB":4097}`, codeImageResizeSizeRange},
		{`{"imageResize":true,"imageResizeMaxKB":49}`, codeImageResizeSizeRange},
	} {
		rec = httptest.NewRecorder()
		h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(tc.body)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d, want 400", tc.body, rec.Code)
		}
		if body := decodeAdminError(t, rec); body["code"] != tc.code {
			t.Fatalf("%s: code=%v, want %s", tc.body, body["code"], tc.code)
		}
	}
	if config.GetImageResize() || config.GetImageResizeMaxDimension() != 1024 || config.GetImageResizeMaxKB() != 300 {
		t.Fatal("a rejected patch changed a setting")
	}
}
