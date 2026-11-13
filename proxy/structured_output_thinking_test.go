package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const structuredThinkingAnswer = `{"name":"Ann","age":30}`

// structuredThinkingUpstreams are the two ways Kiro delivers reasoning: reasoning events,
// and <thinking> tags inline in the text (what the live free accounts send).
func structuredThinkingUpstreams(t *testing.T) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"events": func(w http.ResponseWriter, _ *http.Request) {
			writeFrames(w,
				awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "plan it"}),
				answerFrame(t, structuredThinkingAnswer),
				awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn"}),
				meteringFrame(t),
			)
		},
		"inline tags": func(w http.ResponseWriter, _ *http.Request) {
			writeFrames(w,
				answerFrame(t, "<thinking>plan it</thinking>\n\n"),
				answerFrame(t, structuredThinkingAnswer),
				awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn"}),
				meteringFrame(t),
			)
		},
	}
}

// openAIStreamParts joins a chat stream's content and reasoning_content deltas.
func openAIStreamParts(t *testing.T, body string) (content, reasoning string) {
	t.Helper()
	var c, r strings.Builder
	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
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
		if json.Unmarshal([]byte(data), &chunk) == nil && len(chunk.Choices) > 0 {
			c.WriteString(chunk.Choices[0].Delta.Content)
			r.WriteString(chunk.Choices[0].Delta.ReasoningContent)
		}
	}
	return c.String(), r.String()
}

func postStructuredThinkingChat(t *testing.T, h *Handler, stream, withFormat bool) (content, reasoning string) {
	t.Helper()
	body := map[string]interface{}{
		"model": "claude-sonnet-4.5", "stream": stream, "reasoning_effort": "low",
		"messages": []interface{}{map[string]interface{}{"role": "user", "content": "Describe Ann."}},
	}
	if withFormat {
		body["response_format"] = map[string]interface{}{"type": "json_schema", "json_schema": map[string]interface{}{
			"name": "person", "strict": true, "schema": mustSchema(personSchema),
		}}
	}
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(raw))))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if stream {
		return openAIStreamParts(t, rec.Body.String())
	}
	var resp struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Choices) != 1 {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	return resp.Choices[0].Message.Content, resp.Choices[0].Message.ReasoningContent
}

// The think and thinking chat formats inline reasoning as tags ahead of the content; with a
// JSON response format that broke every client that parses the content.
func TestStructuredOutputChatTagFormatsKeepContentJSON(t *testing.T) {
	for _, format := range []string{"think", "thinking"} {
		for upstreamName, upstream := range structuredThinkingUpstreams(t) {
			for _, stream := range []bool{false, true} {
				h := newStreamTestHandler(t, upstream)
				if err := config.UpdateThinkingConfig("-thinking", format, "thinking"); err != nil {
					t.Fatalf("set thinking format: %v", err)
				}
				content, reasoning := postStructuredThinkingChat(t, h, stream, true)
				if strings.TrimSpace(content) != structuredThinkingAnswer {
					t.Errorf("format=%s upstream=%s stream=%v: content = %q, want only the JSON", format, upstreamName, stream, content)
				}
				if !strings.Contains(reasoning, "plan it") {
					t.Errorf("format=%s upstream=%s stream=%v: reasoning_content = %q, want the reasoning", format, upstreamName, stream, reasoning)
				}
			}
		}
	}
}

func TestStructuredOutputChatTagFormatUnchangedWithoutSpec(t *testing.T) {
	for _, stream := range []bool{false, true} {
		h := newStreamTestHandler(t, structuredThinkingUpstreams(t)["events"])
		if err := config.UpdateThinkingConfig("-thinking", "think", "thinking"); err != nil {
			t.Fatalf("set thinking format: %v", err)
		}
		content, reasoning := postStructuredThinkingChat(t, h, stream, false)
		if !strings.HasPrefix(content, "<think>plan it</think>") || reasoning != "" {
			t.Errorf("stream=%v: content=%q reasoning=%q, want the reasoning inlined as think tags", stream, content, reasoning)
		}
	}
}

// claudeStreamParts joins a /v1/messages stream's text and thinking deltas.
func claudeStreamParts(t *testing.T, body string) (text, thinking string) {
	t.Helper()
	var th strings.Builder
	for _, event := range parseResponsesSSE(t, body) {
		if event.Name != "content_block_delta" {
			continue
		}
		delta := responseSSEMap(t, event.Data["delta"])
		if v, ok := delta["thinking"].(string); ok {
			th.WriteString(v)
		}
	}
	return collectClaudeTextDeltas(t, body), th.String()
}

func TestStructuredOutputMessagesTextThinkingFormatsKeepTextJSON(t *testing.T) {
	for _, format := range []string{"think", "reasoning_content"} {
		for upstreamName, upstream := range structuredThinkingUpstreams(t) {
			for _, stream := range []bool{false, true} {
				h := newStreamTestHandler(t, upstream)
				if err := config.UpdateThinkingConfig("-thinking", "reasoning_content", format); err != nil {
					t.Fatalf("set thinking format: %v", err)
				}
				raw, _ := json.Marshal(map[string]interface{}{
					"model": "claude-sonnet-4.5", "max_tokens": 2048, "stream": stream,
					"thinking":      map[string]interface{}{"type": "enabled", "budget_tokens": 1024},
					"messages":      []interface{}{map[string]interface{}{"role": "user", "content": "Describe Ann."}},
					"output_config": map[string]interface{}{"format": map[string]interface{}{"type": "json_schema", "schema": mustSchema(personSchema)}},
				})
				rec := postClaudeMessages(t, h, string(raw))
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
				var text, thinking string
				if stream {
					text, thinking = claudeStreamParts(t, rec.Body.String())
				} else {
					var resp ClaudeResponse
					if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
						t.Fatalf("decode: %v body=%s", err, rec.Body.String())
					}
					for _, block := range resp.Content {
						switch block.Type {
						case "text":
							text += block.Text
						case "thinking":
							thinking += block.Thinking
						}
					}
				}
				if strings.TrimSpace(text) != structuredThinkingAnswer {
					t.Errorf("format=%s upstream=%s stream=%v: text = %q, want only the JSON", format, upstreamName, stream, text)
				}
				if !strings.Contains(thinking, "plan it") {
					t.Errorf("format=%s upstream=%s stream=%v: thinking = %q, want a thinking block", format, upstreamName, stream, thinking)
				}
			}
		}
	}
}

func TestCountTokensIncludesStructuredOutputInstruction(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Errorf("count_tokens called upstream")
	})
	count := func(body string) int {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body)))
		var resp struct {
			InputTokens int `json:"input_tokens"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &resp) != nil {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		return resp.InputTokens
	}
	const messages = `"messages":[{"role":"user","content":"What is 17*23?"}]`
	const format = `,"output_config":{"format":{"type":"json_schema","schema":` + personSchema + `}}`
	plain := count(`{"model":"claude-sonnet-4.5",` + messages + `}`)
	withFormat := count(`{"model":"claude-sonnet-4.5",` + messages + format + `}`)
	spec := &structuredOutputSpec{Kind: structuredOutputJSONSchema, Strict: true, Schema: mustSchema(personSchema)}
	spec.SchemaText = structuredSchemaTextForTest(t, personSchema)
	if want := plain + structuredOutputPromptTokens(spec, false); withFormat != want {
		t.Fatalf("count with output_config.format = %d, want %d (plain %d plus the injected instruction)", withFormat, want, plain)
	}
	if withFormat-plain < 50 {
		t.Fatalf("the instruction added only %d tokens", withFormat-plain)
	}

	withSystem := count(`{"model":"claude-sonnet-4.5","system":"Be brief.",` + messages + format + `}`)
	plainSystem := count(`{"model":"claude-sonnet-4.5","system":"Be brief.",` + messages + `}`)
	if want := plainSystem + structuredOutputPromptTokens(spec, true); withSystem != want {
		t.Fatalf("count with a system prompt = %d, want %d (no extra priming acknowledgement)", withSystem, want)
	}
	if bad := count(`{"model":"claude-sonnet-4.5",` + messages + `,"output_config":{"format":{"type":"xml"}}}`); bad != plain {
		t.Fatalf("an unsupported format changed the count: %d, want %d", bad, plain)
	}
}

func structuredSchemaTextForTest(t *testing.T, schema string) string {
	t.Helper()
	_, text, msg := structuredSchemaField("schema", mustSchema(schema), json.RawMessage(schema), true)
	if msg != "" {
		t.Fatalf("schema: %s", msg)
	}
	return text
}
