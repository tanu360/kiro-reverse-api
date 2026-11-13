package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// claudeStreamText joins every text_delta of a /v1/messages stream.
func claudeStreamText(t *testing.T, body string) string {
	t.Helper()
	var text strings.Builder
	for _, event := range parseResponsesSSE(t, body) {
		if event.Name != "content_block_delta" {
			continue
		}
		delta := responseSSEMap(t, event.Data["delta"])
		if delta["type"] == "text_delta" {
			text.WriteString(delta["text"].(string))
		}
	}
	return text.String()
}

func claudeMessageText(t *testing.T, body []byte) string {
	t.Helper()
	var msg struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(body, &msg); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	var text strings.Builder
	for _, block := range msg.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return text.String()
}

// Kiro writes "\n\n" after the closing thinking tag. The non-stream answer trims it, so the
// streamed answer must too: every Claude Code stream with thinking printed "\n\nOK".
func TestClaudeStreamTextAfterThinkingHasNoLeadingNewlines(t *testing.T) {
	cases := []struct {
		name     string
		thinking bool
		frames   func(t *testing.T) [][]byte
	}{
		{"inline tags", true, func(t *testing.T) [][]byte {
			return [][]byte{answerFrame(t, "<thinking>plan</thinking>\n\nOK")}
		}},
		{"inline tags split across chunks", true, func(t *testing.T) [][]byte {
			return [][]byte{answerFrame(t, "<thinking>plan</thin"), answerFrame(t, "king>\n"), answerFrame(t, "\nOK, done")}
		}},
		{"reasoning events", true, func(t *testing.T) [][]byte {
			return [][]byte{
				awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "plan"}),
				answerFrame(t, "\n\nOK"),
			}
		}},
		{"thinking not requested", false, func(t *testing.T) [][]byte {
			return [][]byte{answerFrame(t, "<thinking>plan</thinking>\n\nOK")}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
				writeFrames(w, append(tc.frames(t), meteringFrame(t))...)
			})
			body := func(stream bool) string {
				thinking := ""
				if tc.thinking {
					thinking = `"thinking":{"type":"enabled","budget_tokens":1024},`
				}
				return `{"model":"claude-haiku-4.5","max_tokens":2048,"stream":` + map[bool]string{true: "true", false: "false"}[stream] + `,` +
					thinking + `"messages":[{"role":"user","content":"Reply with OK"}]}`
			}
			streamed := postClaudeMessages(t, h, body(true))
			plain := postClaudeMessages(t, h, body(false))
			if streamed.Code != http.StatusOK || plain.Code != http.StatusOK {
				t.Fatalf("status stream=%d plain=%d", streamed.Code, plain.Code)
			}
			got, want := claudeStreamText(t, streamed.Body.String()), claudeMessageText(t, plain.Body.Bytes())
			if got != want || strings.HasPrefix(got, "\n") {
				t.Fatalf("streamed text %q, non-stream text %q", got, want)
			}
		})
	}
}

// Only the whitespace before the first visible character goes, as in the non-stream answer;
// the spacing inside the answer stays.
func TestClaudeStreamTrimsOnlyBeforeTheFirstVisibleText(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, answerFrame(t, "\nA\n\n  B"), meteringFrame(t))
	})
	rec := postClaudeMessages(t, h, `{"model":"claude-haiku-4.5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"x"}]}`)
	if got := claudeStreamText(t, rec.Body.String()); got != "A\n\n  B" {
		t.Fatalf("streamed text %q", got)
	}
}

// The OpenAI chat stream had the same "\n\n" in its first content delta.
func TestOpenAIChatStreamTextAfterThinkingHasNoLeadingNewlines(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, answerFrame(t, "<thinking>plan</thinking>\n\nOK"), meteringFrame(t))
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(
		`{"model":"claude-haiku-4.5","stream":true,"reasoning_effort":"low","messages":[{"role":"user","content":"Reply with OK"}]}`)))
	var content, reasoning strings.Builder
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok || data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			t.Fatalf("decode %s: %v", data, err)
		}
		for _, choice := range chunk.Choices {
			content.WriteString(choice.Delta.Content)
			reasoning.WriteString(choice.Delta.ReasoningContent)
		}
	}
	if content.String() != "OK" || reasoning.String() != "plan" {
		t.Fatalf("content %q reasoning %q, want \"OK\" and \"plan\"", content.String(), reasoning.String())
	}
}
