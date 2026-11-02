package proxy

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func testImageDataURL(seed byte, rawBytes int) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{seed}, rawBytes))
}

func openAIImageTurn(text, dataURL string) OpenAIMessage {
	return OpenAIMessage{Role: "user", Content: []interface{}{
		map[string]interface{}{"type": "text", "text": text},
		map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": dataURL}},
	}}
}

func historyImageSeeds(payload *KiroPayload) []byte {
	var seeds []byte
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage == nil {
			continue
		}
		for _, img := range h.UserInputMessage.Images {
			raw, _ := base64.StdEncoding.DecodeString(img.Source.Bytes)
			seeds = append(seeds, raw[0])
		}
	}
	return seeds
}

func TestHistoryImagesKeepNewestWithinCount(t *testing.T) {
	var msgs []OpenAIMessage
	for i := 0; i < maxHistoryImages+3; i++ {
		msgs = append(msgs, openAIImageTurn(fmt.Sprintf("shot %d", i), testImageDataURL(byte(i+1), 1024)), OpenAIMessage{Role: "assistant", Content: "seen"})
	}
	msgs = append(msgs, OpenAIMessage{Role: "user", Content: []interface{}{
		map[string]interface{}{"type": "text", "text": "now these"},
		map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": testImageDataURL(100, 1024)}},
		map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": testImageDataURL(101, 1024)}},
	}})
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-sonnet-4.5", Messages: msgs}, false)

	seeds := historyImageSeeds(payload)
	if fmt.Sprint(seeds) != fmt.Sprint([]byte{4, 5, 6, 7}) {
		t.Fatalf("history kept images %v, want the newest %d (4 5 6 7)", seeds, maxHistoryImages)
	}
	if got := len(payload.ConversationState.CurrentMessage.UserInputMessage.Images); got != 2 {
		t.Fatalf("current turn images = %d, want 2 untouched", got)
	}
	omitted := 0
	for _, h := range payload.ConversationState.History {
		if u := h.UserInputMessage; u != nil && strings.Contains(u.Content, historyImageOmittedNote) {
			omitted++
			if !strings.Contains(u.Content, "shot ") {
				t.Fatalf("turn text lost when its image was removed: %q", u.Content)
			}
		}
	}
	if omitted != 3 {
		t.Fatalf("placeholder on %d turns, want 3", omitted)
	}
}

func TestHistoryImagesKeepNewestWithinBytes(t *testing.T) {
	raw := maxHistoryImageBytes / 2 * 3 / 4 // two of these fill the base64 budget
	msgs := []OpenAIMessage{
		openAIImageTurn("", testImageDataURL(1, raw)), {Role: "assistant", Content: "a"},
		openAIImageTurn("", testImageDataURL(2, raw)), {Role: "assistant", Content: "b"},
		openAIImageTurn("", testImageDataURL(3, raw)), {Role: "assistant", Content: "c"},
		{Role: "user", Content: "and?"},
	}
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-sonnet-4.5", Messages: msgs}, false)
	if seeds := historyImageSeeds(payload); fmt.Sprint(seeds) != fmt.Sprint([]byte{2, 3}) {
		t.Fatalf("history kept images %v, want the newest two within the byte budget", seeds)
	}
	first := payload.ConversationState.History[0].UserInputMessage
	if strings.Contains(first.Content, normalizeUserContent("", true)) || !strings.Contains(first.Content, historyImageOmittedNote) {
		t.Fatalf("an image-only turn must say its image was removed, got %q", first.Content)
	}
}

func TestHistoryImageBudgetCoversClaudeToolResults(t *testing.T) {
	msgs := []ClaudeMessage{{Role: "user", Content: "take screenshots"}}
	for i := 0; i < maxHistoryImages+2; i++ {
		id := fmt.Sprintf("toolu_%d", i)
		msgs = append(msgs,
			ClaudeMessage{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "tool_use", "id": id, "name": "screenshot", "input": map[string]interface{}{}},
			}},
			ClaudeMessage{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": id, "content": []interface{}{
					map[string]interface{}{"type": "image", "source": map[string]interface{}{
						"type": "base64", "media_type": "image/png",
						"data": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{byte(i + 1)}, 512)),
					}},
				}},
			}},
		)
	}
	msgs = append(msgs, ClaudeMessage{Role: "user", Content: "what changed?"})
	payload := ClaudeToKiro(&ClaudeRequest{Model: "claude-sonnet-4.5", Messages: msgs}, false)
	if got := len(historyImageSeeds(payload)); got != maxHistoryImages {
		t.Fatalf("history kept %d tool-result images, want %d", got, maxHistoryImages)
	}
}
