package proxy

import (
	"bytes"
	"container/list"
	"crypto/sha256"
	"encoding/base64"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

//! Kiro answers 400 to very large image fields, such as the full-screen screenshots
//! Claude Code pastes. Images over the dimension or file-size limit are downscaled and
//! re-encoded before the payload goes upstream; everything else costs one header read.

const (
	// maxResizePixels refuses decompression bombs: a 40 MP RGBA buffer is ~160 MB.
	maxResizePixels = 40_000_000
	// resizeMinLongSide is the floor for the extra shrink steps that chase the byte limit.
	resizeMinLongSide = 512
	resizeShrinkSteps = 4
	resizeCacheSize   = 32
)

// resizeJPEGQualities is the ladder tried at the target size before shrinking further.
var resizeJPEGQualities = [...]int{85, 75, 65}

type imageResizeLimits struct {
	maxDim   int // longest side in pixels
	maxBytes int // decoded file size
}

// currentImageResizeLimits reads the live settings; false when resizing is off.
func currentImageResizeLimits() (imageResizeLimits, bool) {
	if !config.GetImageResize() {
		return imageResizeLimits{}, false
	}
	return imageResizeLimits{
		maxDim:   config.GetImageResizeMaxDimension(),
		maxBytes: config.GetImageResizeMaxKB() * 1024,
	}, true
}

// resizePayloadImages shrinks the current turn's images and the newest
// maxHistoryImages history images in place. Older history images are skipped:
// limitHistoryImages drops them anyway.
func resizePayloadImages(p *KiroPayload) {
	if p == nil {
		return
	}
	lim, on := currentImageResizeLimits()
	if !on {
		return
	}
	cur := &p.ConversationState.CurrentMessage.UserInputMessage
	for i := range cur.Images {
		resizeKiroImage(&cur.Images[i], lim)
	}
	seen := 0
	history := p.ConversationState.History
	for i := len(history) - 1; i >= 0 && seen < maxHistoryImages; i-- {
		msg := history[i].UserInputMessage
		if msg == nil {
			continue
		}
		for j := len(msg.Images) - 1; j >= 0 && seen < maxHistoryImages; j-- {
			resizeKiroImage(&msg.Images[j], lim)
			seen++
		}
	}
}

// resizeKiroImage replaces img's bytes and format with a smaller encoding when the
// image is over a limit. It reports whether img changed. An image that cannot be
// decoded, or whose re-encode would not help, is left untouched.
func resizeKiroImage(img *KiroImage, lim imageResizeLimits) bool {
	data := img.Source.Bytes
	if data == "" {
		return false
	}
	w, h, _, err := imageHeader(data)
	if err != nil || w <= 0 || h <= 0 {
		return false
	}
	if max(w, h) <= lim.maxDim && base64DecodedLen(data) <= lim.maxBytes {
		return false
	}

	key := resizeCacheKey{sum: sha256.Sum256([]byte(data)), maxDim: lim.maxDim, maxBytes: lim.maxBytes}
	if entry, ok := imageResizeCache.get(key); ok {
		if entry.unchanged {
			return false
		}
		logger.Debugf("[ImageResize] cache hit %dx%d -> %dx%d %s %d KB", w, h, entry.w, entry.h, entry.format, len(entry.data)*3/4/1024)
		img.Source.Bytes, img.Format = entry.data, entry.format
		return true
	}

	raw, err := decodeBase64Any(data)
	if err != nil {
		imageResizeCache.put(key, resizeCacheEntry{unchanged: true})
		return false
	}
	start := time.Now()
	out, format, ow, oh, ok := downscaleImage(raw, lim)
	if !ok {
		logger.Debugf("[ImageResize] %dx%d %s %d KB left as is", w, h, img.Format, len(raw)/1024)
		imageResizeCache.put(key, resizeCacheEntry{unchanged: true})
		return false
	}
	encoded := base64.StdEncoding.EncodeToString(out)
	imageResizeCache.put(key, resizeCacheEntry{data: encoded, format: format, w: ow, h: oh})
	logger.Debugf("[ImageResize] %dx%d %s %d KB -> %dx%d %s %d KB in %s", w, h, img.Format, len(raw)/1024, ow, oh, format, len(out)/1024, time.Since(start).Round(time.Millisecond))
	img.Source.Bytes, img.Format = encoded, format
	return true
}

// resizeDecodes counts full image decodes; tests use it to prove the cache works.
var resizeDecodes atomic.Int64

// resizeSem bounds concurrent full decodes, and so the memory they hold.
var resizeSem = make(chan struct{}, max(1, runtime.NumCPU()/2))

// downscaleImage decodes raw (png, jpeg, gif first frame or webp), fits it within
// lim.maxDim and re-encodes it: PNG when it has real transparency and fits
// lim.maxBytes, otherwise JPEG on white. ok is false when raw cannot be decoded or
// the result would be no better than raw.
func downscaleImage(raw []byte, lim imageResizeLimits) (out []byte, format string, w, h int, ok bool) {
	cfg, srcFormat, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, "", 0, 0, false
	}
	switch srcFormat {
	case "png", "jpeg", "gif", "webp":
	default:
		return nil, "", 0, 0, false
	}
	if int64(cfg.Width)*int64(cfg.Height) > maxResizePixels {
		logger.Debugf("[ImageResize] %dx%d %s is over %d pixels, left as is", cfg.Width, cfg.Height, srcFormat, maxResizePixels)
		return nil, "", 0, 0, false
	}

	resizeSem <- struct{}{}
	defer func() { <-resizeSem }()

	resizeDecodes.Add(1)
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", 0, 0, false
	}
	orientation := 1
	if srcFormat == "jpeg" {
		orientation = jpegOrientation(raw)
	}
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()

	render := func(tw, th int, flatten bool) *image.RGBA {
		img := scaleTo(src, tw, th)
		if flatten {
			img = flattenOnWhite(img)
		}
		return applyOrientation(img, orientation)
	}

	tw, th := fitWithin(sw, sh, lim.maxDim)
	scaled := render(tw, th, false)
	opaque := scaled.Opaque()

	var best []byte
	bestW, bestH := 0, 0
	consider := func(data []byte, f string, img *image.RGBA) bool {
		if data == nil {
			return false
		}
		if best == nil || len(data) < len(best) {
			best, format = data, f
			bestW, bestH = img.Bounds().Dx(), img.Bounds().Dy()
		}
		return len(data) <= lim.maxBytes
	}

	fits := false
	if !opaque {
		fits = consider(encodePNG(scaled), "png", scaled)
		if !fits {
			scaled = flattenOnWhite(scaled)
		}
	}
	for _, q := range resizeJPEGQualities {
		if fits {
			break
		}
		fits = consider(encodeJPEG(scaled, q), "jpeg", scaled)
	}
	for step := 0; !fits && step < resizeShrinkSteps; step++ {
		long := max(tw, th)
		next := max(long*3/4, resizeMinLongSide)
		if next >= long {
			break
		}
		tw, th = fitWithin(tw, th, next)
		smaller := render(tw, th, !opaque)
		fits = consider(encodeJPEG(smaller, resizeJPEGQualities[1]), "jpeg", smaller)
	}

	if best == nil {
		return nil, "", 0, 0, false
	}
	// Only the size limit was hit: a re-encode that is not smaller makes it worse.
	reduced := bestW*bestH < sw*sh
	if !reduced && len(best) >= len(raw) {
		return nil, "", 0, 0, false
	}
	return best, format, bestW, bestH, true
}

// fitWithin scales w x h so the longest side is at most maxDim, keeping the aspect
// ratio. It never upscales and keeps each side at least 1.
func fitWithin(w, h, maxDim int) (int, int) {
	if w <= 0 || h <= 0 || maxDim <= 0 || max(w, h) <= maxDim {
		return w, h
	}
	if w >= h {
		return maxDim, max(1, int(float64(h)*float64(maxDim)/float64(w)+0.5))
	}
	return max(1, int(float64(w)*float64(maxDim)/float64(h)+0.5)), maxDim
}

func scaleTo(src image.Image, w, h int) *image.RGBA {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	if w == b.Dx() && h == b.Dy() {
		draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
		return dst
	}
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	return dst
}

// flattenOnWhite composites img over an opaque white background.
func flattenOnWhite(img *image.RGBA) *image.RGBA {
	dst := image.NewRGBA(img.Bounds())
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, img.Bounds().Min, draw.Over)
	return dst
}

func encodeJPEG(img image.Image, quality int) []byte {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil
	}
	return buf.Bytes()
}

func encodePNG(img image.Image) []byte {
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.DefaultCompression}).Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

// base64DecodedLen is the decoded size of a base64 string, without decoding it.
func base64DecodedLen(s string) int {
	return len(s) * 3 / 4
}

// decodeBase64Any accepts the same alphabets as parseBase64Image.
func decodeBase64Any(s string) ([]byte, error) {
	var firstErr error
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		raw, err := enc.DecodeString(s)
		if err == nil {
			return raw, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

// imageHeader reads an image's dimensions and format from its base64 header only,
// in the standard or the URL-safe alphabet. The streaming decoders never reach a
// missing final padding, so unpadded input works too.
func imageHeader(data string) (w, h int, format string, err error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
		var cfg image.Config
		cfg, format, err = image.DecodeConfig(base64.NewDecoder(enc, strings.NewReader(data)))
		if err == nil {
			return cfg.Width, cfg.Height, format, nil
		}
	}
	return 0, 0, "", err
}

type resizeCacheKey struct {
	sum      [sha256.Size]byte
	maxDim   int
	maxBytes int
}

type resizeCacheEntry struct {
	data      string
	format    string
	w, h      int
	unchanged bool
}

// resizeLRU remembers recent results: Claude Code replays the same screenshot
// every turn, so each one is resized once per process.
type resizeLRU struct {
	mu    sync.Mutex
	cap   int
	order *list.List // front = most recent; values are *resizeLRUItem
	items map[resizeCacheKey]*list.Element
}

type resizeLRUItem struct {
	key   resizeCacheKey
	entry resizeCacheEntry
}

func newResizeLRU(capacity int) *resizeLRU {
	return &resizeLRU{cap: capacity, order: list.New(), items: make(map[resizeCacheKey]*list.Element)}
}

var imageResizeCache = newResizeLRU(resizeCacheSize)

func (c *resizeLRU) get(key resizeCacheKey) (resizeCacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return resizeCacheEntry{}, false
	}
	c.order.MoveToFront(el)
	return el.Value.(*resizeLRUItem).entry, true
}

func (c *resizeLRU) put(key resizeCacheKey, entry resizeCacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		el.Value.(*resizeLRUItem).entry = entry
		c.order.MoveToFront(el)
		return
	}
	c.items[key] = c.order.PushFront(&resizeLRUItem{key: key, entry: entry})
	for c.order.Len() > c.cap {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*resizeLRUItem).key)
	}
}

func (c *resizeLRU) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.order.Init()
	clear(c.items)
}
