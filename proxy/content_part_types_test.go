package proxy

import (
	"encoding/json"
	"testing"
)

// A content array element that is not an object (a bare string or number) is named with its
// field. Before, it was dropped without a word: alone it read as "at least one non-empty user
// message is required", and beside a text block the request went on without it.
func TestContentPartThatIsNotAnObjectIsNamed(t *testing.T) {
	text := map[string]interface{}{"type": "text", "text": "hi"}

	claude := []struct {
		content interface{}
		want    string
	}{
		{[]interface{}{"hi"}, "messages.0.content.0 must be an object, not a string"},
		{[]interface{}{text, 5.0}, "messages.0.content.1 must be an object, not a number"},
	}
	for _, c := range claude {
		req := &ClaudeRequest{MaxTokens: 16, Messages: []ClaudeMessage{{Role: "user", Content: c.content}}}
		if got := validateClaudeRequestShape(req); got != c.want {
			t.Errorf("messages: content %v: got %q, want %q", c.content, got, c.want)
		}
		if got := validateClaudeCountTokensShape(req); got != c.want {
			t.Errorf("count_tokens: content %v: got %q, want %q", c.content, got, c.want)
		}
	}

	chat := &OpenAIRequest{Messages: []OpenAIMessage{
		{Role: "system", Content: "be brief"},
		{Role: "user", Content: []interface{}{text, true}},
	}}
	if got, want := validateOpenAIRequestShape(chat), "messages[1].content[1] must be an object, not a boolean"; got != want {
		t.Errorf("chat: got %q, want %q", got, want)
	}

	for _, c := range []struct{ body, want string }{
		{`{"model":"m","input":[{"role":"user","content":["hi"]}]}`, "input[0].content[0] must be an object, not a string"},
		{`{"model":"m","input":[{"role":"user","content":"hi"},{"type":"message","role":"user","content":[{"type":"input_text","text":"x"},7]}]}`,
			"input[1].content[1] must be an object, not a number"},
	} {
		var req OpenAIResponsesRequest
		if err := json.Unmarshal([]byte(c.body), &req); err != nil {
			t.Fatal(err)
		}
		if _, got := prepareResponsesRequest(&req, nil); got != c.want {
			t.Errorf("responses %s: got %q, want %q", c.body, got, c.want)
		}
	}

	// Arrays of objects stay as they were, whatever their block types.
	if got := validateClaudeRequestShape(&ClaudeRequest{MaxTokens: 16, Messages: []ClaudeMessage{{Role: "user", Content: []interface{}{text}}}}); got != "" {
		t.Errorf("text block refused: %q", got)
	}
	if got := validateOpenAIRequestShape(&OpenAIRequest{Messages: []OpenAIMessage{{Role: "user", Content: []interface{}{text}}}}); got != "" {
		t.Errorf("text part refused: %q", got)
	}
	var ok OpenAIResponsesRequest
	if err := json.Unmarshal([]byte(`{"model":"m","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}`), &ok); err != nil {
		t.Fatal(err)
	}
	if _, got := prepareResponsesRequest(&ok, nil); got != "" {
		t.Errorf("input_text part refused: %q", got)
	}
}
