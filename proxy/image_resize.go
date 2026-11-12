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
	// maxResizePixels bounds the CPU time one decode can take (about 1-2 s at 40 MP).
	maxResizePixels = 40_000_000
	// resizeMemoryBudget bounds the memory all running decodes hold together, as
	// resizeDecodeCost estimates it. An image that alone needs more is left as is.
	resizeMemoryBudget = 512 << 20
	// resizeMaxDecodesPerPayload caps the full decodes one request can cause; cache
	// hits do not count. The images after that go upstream as they are.
	resizeMaxDecodesPerPayload = 8
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
	decodes := resizeMaxDecodesPerPayload
	cur := &p.ConversationState.CurrentMessage.UserInputMessage
	for i := range cur.Images {
		resizeImage(&cur.Images[i], lim, &decodes)
	}
	seen := 0
	history := p.ConversationState.History
	for i := len(history) - 1; i >= 0 && seen < maxHistoryImages; i-- {
		msg := history[i].UserInputMessage
		if msg == nil {
			continue
		}
		for j := len(msg.Images) - 1; j >= 0 && seen < maxHistoryImages; j-- {
			resizeImage(&msg.Images[j], lim, &decodes)
			seen++
		}
	}
}

// resizeKiroImage replaces img's bytes and format with a smaller encoding when the
// image is over a limit. It reports whether img changed. An image that cannot be
// decoded, or whose re-encode would not help, is left untouched.
func resizeKiroImage(img *KiroImage, lim imageResizeLimits) bool {
	decodes := 1
	return resizeImage(img, lim, &decodes)
}

// resizeImage is resizeKiroImage drawing on a request's allowance of full decodes.
// An image skipped for the allowance or a full memory budget is not cached, so a
// later request can still resize it.
func resizeImage(img *KiroImage, lim imageResizeLimits, decodes *int) bool {
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
	cost, ok := resizeDecodeCost(raw, lim)
	if !ok {
		imageResizeCache.put(key, resizeCacheEntry{unchanged: true})
		return false
	}
	if *decodes <= 0 {
		logger.Debugf("[ImageResize] %dx%d %s left as is: %d images already decoded for this request", w, h, img.Format, resizeMaxDecodesPerPayload)
		return false
	}
	*decodes--
	start := time.Now()
	if !resizeBudget.acquire(cost, resizeBudgetWait) {
		logger.Debugf("[ImageResize] %dx%d %s left as is: no memory budget for %d MB after %s", w, h, img.Format, cost>>20, resizeBudgetWait)
		return false
	}
	out, format, ow, oh, ok := downscaleImage(raw, lim)
	resizeBudget.release(cost)
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

// resizeBudget is shared by every request's full decodes. resizeBudgetWait bounds
// how long an image waits for it before it goes upstream as is: the translator has
// no request context, so a cancelled request cannot stop waiting any sooner.
var (
	resizeBudget     = newMemoryBudget(resizeMemoryBudget)
	resizeBudgetWait = 10 * time.Second
)

// resizeDecodeCost estimates the peak bytes downscaleImage holds for raw: the
// decoded source, the scaler's buffer of four float64 per destination column and
// source row, and a few copies of the output. ok is false for a format that is not
// resized and for an image over maxResizePixels or the whole memory budget.
func resizeDecodeCost(raw []byte, lim imageResizeLimits) (cost int64, ok bool) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return 0, false
	}
	switch format {
	case "png", "jpeg", "gif", "webp":
	default:
		return 0, false
	}
	sw, sh := int64(cfg.Width), int64(cfg.Height)
	if sw*sh > maxResizePixels {
		logger.Debugf("[ImageResize] %dx%d %s is over %d pixels, left as is", sw, sh, format, maxResizePixels)
		return 0, false
	}
	tw, th := fitWithin(cfg.Width, cfg.Height, lim.maxDim)
	cost = sw*sh*decodedBytesPerPixel(cfg.ColorModel, format, raw) + int64(tw)*sh*32 + int64(tw)*int64(th)*4*3
	if cost > resizeMemoryBudget {
		logger.Debugf("[ImageResize] %dx%d %s needs about %d MB to resize, over the %d MB budget, left as is", sw, sh, format, cost>>20, resizeMemoryBudget>>20)
		return 0, false
	}
	return cost, true
}

// decodedBytesPerPixel is an upper bound on what the decoder allocates per pixel.
// The PNG decoder reports Gray16 for a 16-bit grey image but returns NRGBA64 when
// it has a transparent colour; lossless WebP and progressive JPEG keep a second
// buffer (progressive coefficients are 4 B per sample per component).
func decodedBytesPerPixel(model color.Model, format string, raw []byte) int64 {
	switch {
	case model == color.RGBA64Model, model == color.NRGBA64Model, model == color.Gray16Model, format == "webp":
		return 8
	case format == "jpeg" && jpegProgressive(raw):
		return 16
	}
	return 4
}

// downscaleImage decodes raw (png, jpeg, gif first frame or webp), fits it within
// lim.maxDim and re-encodes it: PNG when it has real transparency and fits
// lim.maxBytes, otherwise JPEG on white. ok is false when raw cannot be decoded or
// the result would be no better than raw. The caller holds resizeBudget for it.
func downscaleImage(raw []byte, lim imageResizeLimits) (out []byte, format string, w, h int, ok bool) {
	resizeDecodes.Add(1)
	src, srcFormat, err := image.Decode(bytes.NewReader(raw))
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

// memoryBudget is a semaphore weighted in bytes whose waits are bounded.
type memoryBudget struct {
	mu    sync.Mutex
	free  int64
	freed chan struct{} // closed and replaced on every release
}

func newMemoryBudget(size int64) *memoryBudget {
	return &memoryBudget{free: size, freed: make(chan struct{})}
}

// acquire takes n bytes, waiting up to wait for running decodes to give them back.
func (b *memoryBudget) acquire(n int64, wait time.Duration) bool {
	var timeout <-chan time.Time
	for {
		b.mu.Lock()
		if n <= b.free {
			b.free -= n
			b.mu.Unlock()
			return true
		}
		freed := b.freed
		b.mu.Unlock()
		if timeout == nil {
			timer := time.NewTimer(wait)
			defer timer.Stop()
			timeout = timer.C
		}
		select {
		case <-freed:
		case <-timeout:
			return false
		}
	}
}

func (b *memoryBudget) release(n int64) {
	b.mu.Lock()
	b.free += n
	close(b.freed)
	b.freed = make(chan struct{})
	b.mu.Unlock()
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
