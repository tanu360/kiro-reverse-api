package proxy

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestMultimodalUserTextSurvivesImageBudget(t *testing.T) {
	imageData := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("image-data", 110000)))
	want := "请按剧本设计分镜。\n[Image 1] 是演员甲；[Image 2] 是演员乙。\n保持人物与图片的对应关系。"
	for _, protocol := range []string{"claude", "openai"} {
		for _, textLast := range []bool{false, true} {
			name := protocol + "/text-first"
			if textLast {
				name = protocol + "/text-last"
			}
			t.Run(name, func(t *testing.T) {
				textBlock := map[string]interface{}{"type": "text", "text": want}
				var imageBlock map[string]interface{}
				if protocol == "claude" {
					imageBlock = map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "base64", "media_type": "image/png", "data": imageData}}
				} else {
					imageBlock = map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": "data:image/png;base64," + imageData}}
				}
				content := []interface{}{textBlock, imageBlock}
				if textLast {
					content = []interface{}{imageBlock, textBlock}
				}
				var payload *KiroPayload
				if protocol == "claude" {
					payload = ClaudeToKiro(&ClaudeRequest{Model: "claude-opus-5.5", System: "Follow the user request.", Messages: []ClaudeMessage{{Role: "user", Content: content}}}, false)
				} else {
					payload = OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-5.5", Messages: []OpenAIMessage{{Role: "system", Content: "Follow the user request."}, {Role: "user", Content: content}}}, false)
				}
				raw, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				var wire KiroPayload
				if err := json.Unmarshal(raw, &wire); err != nil {
					t.Fatal(err)
				}
				got := wire.ConversationState.CurrentMessage.UserInputMessage
				if got.Content != want {
					t.Fatalf("user text or image labels changed: got %q, want %q", got.Content, want)
				}
				if len(got.Images) != 1 || got.Images[0].Source.Bytes != imageData {
					t.Fatal("image attachment was lost or changed")
				}
			})
		}
	}
}

func TestMultimodalImageLabelsAndWhitespacePreserved(t *testing.T) {
	want := "[Image 1] 演员甲\n\n[Image 2] 演员乙\n  第二幕：两人在门口相遇。"
	content := []interface{}{
		map[string]interface{}{"type": "text", "text": want},
		map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": "data:image/png;base64,aW1hZ2U="}},
	}
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-5.5", Messages: []OpenAIMessage{{Role: "user", Content: content}}}, false)
	if got := payload.ConversationState.CurrentMessage.UserInputMessage.Content; got != want {
		t.Fatalf("image labels or layout changed: got %q, want %q", got, want)
	}
}

func TestMultimodalImagesDoNotEvictRecentHistory(t *testing.T) {
	imageData := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("image-data", 110000)))
	previousText := "[Image 1] 是主角。保留这个角色名称。"
	req := &ClaudeRequest{Model: "claude-opus-5.5", Messages: []ClaudeMessage{
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "text", "text": previousText},
			map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "base64", "media_type": "image/png", "data": imageData}},
		}},
		{Role: "assistant", Content: "已记录。"},
		{Role: "user", Content: "继续第二幕，保留角色对应关系。"},
	}}
	payload := ClaudeToKiro(req, false)
	if got := payload.ConversationState.CurrentMessage.UserInputMessage.Content; got != req.Messages[2].Content {
		t.Fatalf("current user text lost: %q", got)
	}
	history := payload.ConversationState.History
	if len(history) != 2 || history[0].UserInputMessage == nil || history[0].UserInputMessage.Content != previousText || len(history[0].UserInputMessage.Images) != 1 {
		t.Fatal("recent multimodal history was lost")
	}
}
