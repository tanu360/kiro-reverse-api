package proxy

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"testing"
)

// noisyPNG returns a base64 PNG that compresses badly, so its base64 is large.
func noisyPNG(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	rng := rand.New(rand.NewSource(1))
	rng.Read(img.Pix)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func testWebPVP8X(w, h int) string {
	b := make([]byte, 30)
	copy(b[0:], "RIFF")
	binary.LittleEndian.PutUint32(b[4:], 22)
	copy(b[8:], "WEBPVP8X")
	binary.LittleEndian.PutUint32(b[16:], 10)
	put24 := func(off, v int) { b[off], b[off+1], b[off+2] = byte(v), byte(v>>8), byte(v>>16) }
	put24(24, w-1)
	put24(27, h-1)
	return base64.StdEncoding.EncodeToString(b)
}

func TestEstimateImageDataTokens(t *testing.T) {
	var jpg, gf bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewGray(image.Rect(0, 0, 200, 150)), nil); err != nil {
		t.Fatal(err)
	}
	if err := gif.Encode(&gf, image.NewPaletted(image.Rect(0, 0, 30, 30), []color.Color{color.Black}), nil); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		data string
		want int
	}{
		{"png", noisyPNG(t, 300, 250), 100},
		{"jpeg", base64.StdEncoding.EncodeToString(jpg.Bytes()), 40},
		{"gif", base64.StdEncoding.EncodeToString(gf.Bytes()), 2},
		{"webp", testWebPVP8X(750, 100), 100},
		{"webp low byte carries", testWebPVP8X(512, 512), (512*512 + 749) / 750},
		{"capped", testWebPVP8X(4000, 3000), maxImageTokens},
		{"undecodable", base64.StdEncoding.EncodeToString([]byte("not an image at all")), maxImageTokens},
	}
	for _, tc := range cases {
		if got := estimateImageDataTokens(tc.data); got != tc.want {
			t.Errorf("%s: %d tokens, want %d", tc.name, got, tc.want)
		}
	}
}

func TestOpenAIEstimateCountsImagesAtFixedCost(t *testing.T) {
	data := noisyPNG(t, 300, 250)
	if len(data) < 200_000 {
		t.Fatalf("test image too small to show the bug: %d bytes", len(data))
	}
	url := "data:image/png;base64," + data
	req := &OpenAIRequest{Messages: []OpenAIMessage{
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "text", "text": "what is this"},
			map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": url}},
		}},
		{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_1", "screenshot", `{}`)}},
		{Role: "tool", ToolCallID: "call_1", Content: []interface{}{
			map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": url}},
		}},
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": "https://example.com/cat.png"}},
		}},
	}}
	got := estimateOpenAIRequestInputTokens(req)
	if got < 2*100+maxImageTokens || got > 2*100+maxImageTokens+100 {
		t.Fatalf("estimate = %d, want two 100-token images plus one remote image (%d) plus a little text", got, maxImageTokens)
	}
}

func TestResponsesEstimateCountsToolOutputImagesAtFixedCost(t *testing.T) {
	url := "data:image/png;base64," + noisyPNG(t, 300, 250)
	input, _ := json.Marshal([]interface{}{
		map[string]interface{}{"type": "message", "role": "user", "content": []interface{}{
			map[string]interface{}{"type": "input_text", "text": "look"},
			map[string]interface{}{"type": "input_image", "image_url": url},
		}},
		map[string]interface{}{"type": "function_call", "call_id": "call_1", "name": "screenshot", "arguments": "{}"},
		map[string]interface{}{"type": "function_call_output", "call_id": "call_1", "output": []interface{}{
			map[string]interface{}{"type": "input_image", "image_url": url},
		}},
	})
	prepared, msg := prepareResponsesRequest(&OpenAIResponsesRequest{Model: "claude-sonnet-4.5", Input: input}, nil)
	if msg != "" {
		t.Fatal(msg)
	}
	if got := estimateOpenAIRequestInputTokens(&prepared.OpenAIRequest); got < 200 || got > 300 {
		t.Fatalf("estimate = %d, want about two 100-token images", got)
	}
}

func TestClaudeEstimateCountsImagesAtFixedCost(t *testing.T) {
	data := noisyPNG(t, 300, 250)
	image := map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "base64", "media_type": "image/png", "data": data}}
	req := &ClaudeRequest{Messages: []ClaudeMessage{
		{Role: "user", Content: []interface{}{map[string]interface{}{"type": "text", "text": "look"}, image}},
		{Role: "assistant", Content: []interface{}{map[string]interface{}{"type": "tool_use", "id": "t1", "name": "shot", "input": map[string]interface{}{}}}},
		{Role: "user", Content: []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": []interface{}{image}}}},
	}}
	if got := estimateClaudeRequestInputTokens(req); got < 200 || got > 300 {
		t.Fatalf("estimate = %d, want about two 100-token images", got)
	}
}
