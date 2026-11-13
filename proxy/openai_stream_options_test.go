package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type chatStreamChunk struct {
	Choices []struct {
		Delta        map[string]interface{} `json:"delta"`
		FinishReason *string                `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

// chatStreamChunks decodes every data line of a chat stream up to [DONE].
func chatStreamChunks(t *testing.T, body string) (chunks []chatStreamChunk, done bool) {
	t.Helper()
	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		if data == "[DONE]" {
			return chunks, true
		}
		var chunk chatStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			t.Fatalf("decode chunk %q: %v", data, err)
		}
		chunks = append(chunks, chunk)
	}
	return chunks, false
}

func postChatStream(t *testing.T, h *Handler, extra map[string]interface{}) string {
	t.Helper()
	body := map[string]interface{}{
		"model": "claude-sonnet-4.5", "stream": true,
		"messages": []interface{}{map[string]interface{}{"role": "user", "content": "Count to 3."}},
	}
	for k, v := range extra {
		body[k] = v
	}
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(raw))))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	return rec.Body.String()
}

func plainAnswerUpstream(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			answerFrame(t, "1 2 3"),
			awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn"}),
			meteringFrame(t),
		)
	}
}

// stream_options.include_usage asks for the usage on its own chunk with empty
// choices, right before [DONE]; the OpenAI SDKs and spec-strict clients read it there.
func TestOpenAIStreamIncludeUsageSendsUsageChunk(t *testing.T) {
	h := newStreamTestHandler(t, plainAnswerUpstream(t))
	chunks, done := chatStreamChunks(t, postChatStream(t, h, map[string]interface{}{
		"stream_options": map[string]interface{}{"include_usage": true},
	}))
	if !done || len(chunks) < 3 {
		t.Fatalf("done=%v chunks=%d, want a full stream", done, len(chunks))
	}
	last := chunks[len(chunks)-1]
	if last.Choices == nil || len(last.Choices) != 0 || last.Usage == nil || last.Usage.TotalTokens == 0 {
		t.Fatalf("last chunk = %+v, want choices [] and the usage", last)
	}
	finish := chunks[len(chunks)-2]
	if len(finish.Choices) != 1 || finish.Choices[0].FinishReason == nil || *finish.Choices[0].FinishReason != "stop" {
		t.Fatalf("finish chunk = %+v", finish)
	}
	for i, c := range chunks[:len(chunks)-1] {
		if c.Usage != nil {
			t.Fatalf("chunk %d carries usage %+v; only the last one should", i, c.Usage)
		}
	}
}

// Without stream_options the usage stays on the finish chunk, as before.
func TestOpenAIStreamWithoutIncludeUsageKeepsUsageOnFinishChunk(t *testing.T) {
	h := newStreamTestHandler(t, plainAnswerUpstream(t))
	chunks, done := chatStreamChunks(t, postChatStream(t, h, nil))
	if !done || len(chunks) < 2 {
		t.Fatalf("done=%v chunks=%d", done, len(chunks))
	}
	last := chunks[len(chunks)-1]
	if len(last.Choices) != 1 || last.Choices[0].FinishReason == nil || last.Usage == nil {
		t.Fatalf("last chunk = %+v, want the finish chunk with usage", last)
	}
	for _, c := range chunks {
		if len(c.Choices) == 0 {
			t.Fatalf("got an empty-choices chunk without stream_options: %+v", c)
		}
	}
}

// The first chunk names the assistant role, as OpenAI's stream does.
func TestOpenAIStreamFirstChunkHasAssistantRole(t *testing.T) {
	for name, upstream := range map[string]http.HandlerFunc{
		"text": plainAnswerUpstream(t),
		"tool": func(w http.ResponseWriter, _ *http.Request) {
			writeFrames(w, weatherToolFrame(t), meteringFrame(t))
		},
	} {
		h := newStreamTestHandler(t, upstream)
		chunks, _ := chatStreamChunks(t, postChatStream(t, h, nil))
		if len(chunks) < 2 {
			t.Fatalf("%s: chunks=%d", name, len(chunks))
		}
		if role := chunks[0].Choices[0].Delta["role"]; role != "assistant" {
			t.Errorf("%s: first delta = %v, want role assistant", name, chunks[0].Choices[0].Delta)
		}
		for i, c := range chunks[1:] {
			if len(c.Choices) > 0 && c.Choices[0].Delta["role"] != nil {
				t.Errorf("%s: chunk %d repeats the role: %v", name, i+1, c.Choices[0].Delta)
			}
		}
	}
}

// Kiro leaves "\n" after <thinking> and "\n\n" after </thinking>. The streamed
// content and reasoning_content start at the first real character, as the
// non-stream reply does, so a JSON answer is byte-pure JSON.
func TestOpenAIStreamTrimsWhitespaceAroundThinking(t *testing.T) {
	inlineTags := func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			answerFrame(t, "<thinking>\nplan it\n</thinking>\n\n"),
			answerFrame(t, structuredThinkingAnswer),
			awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn"}),
			meteringFrame(t),
		)
	}
	for _, format := range []string{"think", "reasoning_content"} {
		for _, stream := range []bool{true, false} {
			h := newStreamTestHandler(t, inlineTags)
			if err := config.UpdateThinkingConfig("-thinking", format, "thinking"); err != nil {
				t.Fatalf("set thinking format: %v", err)
			}
			content, reasoning := postStructuredThinkingChat(t, h, stream, true)
			if content != structuredThinkingAnswer {
				t.Errorf("format=%s stream=%v: content = %q, want exactly the JSON", format, stream, content)
			}
			if reasoning != "plan it\n" {
				t.Errorf("format=%s stream=%v: reasoning_content = %q, want %q", format, stream, reasoning, "plan it\n")
			}
		}
	}
}

// With the think tag format and no JSON request, the streamed content matches
// the non-stream reply: no blank line between </think> and the answer.
func TestOpenAIStreamThinkTagContentMatchesNonStream(t *testing.T) {
	upstream := func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			answerFrame(t, "<thinking>\nplan it\n</thinking>\n\n42"),
			awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn"}),
			meteringFrame(t),
		)
	}
	var got [2]string
	for i, stream := range []bool{false, true} {
		h := newStreamTestHandler(t, upstream)
		if err := config.UpdateThinkingConfig("-thinking", "think", "thinking"); err != nil {
			t.Fatalf("set thinking format: %v", err)
		}
		got[i], _ = postStructuredThinkingChat(t, h, stream, false)
	}
	if got[0] != got[1] || got[1] != "<think>\nplan it\n</think>42" {
		t.Fatalf("non-stream %q, stream %q, want both %q", got[0], got[1], "<think>\nplan it\n</think>42")
	}
}
