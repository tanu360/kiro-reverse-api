package proxy

import (
	"encoding/json"
	"testing"
)

// A request whose only content is of a type the proxy cannot read names that block. It used to
// read "at least one non-empty user message is required" (or "input is required"), which sent
// the client looking at the wrong field.
func TestUnreadableContentIsNamedWhenNothingElseIsLeft(t *testing.T) {
	bogus := map[string]interface{}{"type": "bogus"}
	claude := []struct {
		messages []ClaudeMessage
		want     string
	}{
		{[]ClaudeMessage{{Role: "user", Content: []interface{}{bogus}}},
			`messages.0.content.0 has type "bogus", which this proxy cannot read`},
		{[]ClaudeMessage{
			{Role: "user", Content: " "},
			{Role: "assistant", Content: "hello"},
			{Role: "user", Content: []interface{}{map[string]interface{}{"type": "text", "text": " "}, bogus}},
		}, `messages.2.content.1 has type "bogus", which this proxy cannot read`},
		{[]ClaudeMessage{{Role: "user", Content: []interface{}{map[string]interface{}{"text": "hi"}}}},
			"messages.0.content.0 has no type, so this proxy cannot read it"},
		{[]ClaudeMessage{{Role: "user", Content: []interface{}{map[string]interface{}{"type": 3.0}}}},
			"messages.0.content.0.type must be a string, not a number"},
	}
	for _, c := range claude {
		if got := validateClaudeRequestShape(&ClaudeRequest{MaxTokens: 16, Messages: c.messages}); got != c.want {
			t.Errorf("messages %v: got %q, want %q", c.messages, got, c.want)
		}
	}

	chat := []struct {
		messages []OpenAIMessage
		want     string
	}{
		{[]OpenAIMessage{{Role: "user", Content: []interface{}{bogus}}},
			`messages[0].content[0] has type "bogus", which this proxy cannot read`},
		{[]OpenAIMessage{{Role: "system", Content: "be brief"}, {Role: "user", Content: []interface{}{map[string]interface{}{"type": "input_audio", "input_audio": map[string]interface{}{"data": "AAAA", "format": "wav"}}}}},
			`messages[1].content[0] has type "input_audio", which this proxy cannot read`},
	}
	for _, c := range chat {
		if got := validateOpenAIRequestShape(&OpenAIRequest{Messages: c.messages}); got != c.want {
			t.Errorf("chat %v: got %q, want %q", c.messages, got, c.want)
		}
	}

	for _, c := range []struct{ body, want string }{
		{`{"model":"m","input":[{"type":"bogus"}]}`, `input[0] has type "bogus", which this proxy cannot read`},
		{`{"model":"m","input":{"type":"bogus"}}`, `input has type "bogus", which this proxy cannot read`},
		{`{"model":"m","input":[{"role":"system","content":"be brief"},{"type":"reasoning","summary":[]}]}`,
			`input[1] has type "reasoning", which this proxy cannot read`},
		{`{"model":"m","input":[{"role":"user","content":[{"type":"bogus"}]}]}`, `input[0].content[0] has type "bogus", which this proxy cannot read`},
		{`{"model":"m","instructions":"be brief","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":""},{"type":"bogus"}]}]}`,
			`input[0].content[1] has type "bogus", which this proxy cannot read`},
	} {
		var req OpenAIResponsesRequest
		if err := json.Unmarshal([]byte(c.body), &req); err != nil {
			t.Fatal(err)
		}
		if _, got := prepareResponsesRequest(&req, nil); got != c.want {
			t.Errorf("responses %s: got %q, want %q", c.body, got, c.want)
		}
	}
}

// Beside content the proxy reads, a block of an unknown type is still skipped without a word:
// clients send newer block types, and the rest of the request is fine.
func TestUnreadableContentNextToTextIsStillSkipped(t *testing.T) {
	text := map[string]interface{}{"type": "text", "text": "hi"}
	bogus := map[string]interface{}{"type": "bogus"}
	if got := validateClaudeRequestShape(&ClaudeRequest{MaxTokens: 16, Messages: []ClaudeMessage{{Role: "user", Content: []interface{}{bogus, text}}}}); got != "" {
		t.Errorf("messages: %q", got)
	}
	if got := validateOpenAIRequestShape(&OpenAIRequest{Messages: []OpenAIMessage{{Role: "user", Content: []interface{}{text, bogus}}}}); got != "" {
		t.Errorf("chat: %q", got)
	}
	for _, body := range []string{
		`{"model":"m","input":[{"type":"reasoning","summary":[]},{"role":"user","content":"hi"}]}`,
		`{"model":"m","input":[{"role":"user","content":[{"type":"bogus"},{"type":"input_text","text":"hi"}]}]}`,
	} {
		var req OpenAIResponsesRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		if _, got := prepareResponsesRequest(&req, nil); got != "" {
			t.Errorf("responses %s: %q", body, got)
		}
	}
	// A request that is empty for another reason keeps its own message.
	if got, want := validateClaudeRequestShape(&ClaudeRequest{MaxTokens: 16, Messages: []ClaudeMessage{{Role: "user", Content: []interface{}{map[string]interface{}{"type": "text", "text": ""}}}}}), "at least one non-empty user message is required"; got != want {
		t.Errorf("empty text block: got %q, want %q", got, want)
	}
}
