package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A message whose content is neither a string nor an array is named with its field, not
// reported as "at least one non-empty user message is required".
func TestClaudeContentTypeIsNamed(t *testing.T) {
	cases := []struct {
		content interface{}
		want    string
	}{
		{5.0, "messages.0.content must be a string or an array of content blocks, not a number"},
		{true, "messages.0.content must be a string or an array of content blocks, not a boolean"},
		{map[string]interface{}{"type": "text"}, "messages.0.content must be a string or an array of content blocks, not an object"},
	}
	for _, c := range cases {
		req := &ClaudeRequest{MaxTokens: 16, Messages: []ClaudeMessage{{Role: "user", Content: c.content}}}
		if got := validateClaudeRequestShape(req); got != c.want {
			t.Errorf("messages: content %v: got %q, want %q", c.content, got, c.want)
		}
		if got := validateClaudeCountTokensShape(req); got != c.want {
			t.Errorf("count_tokens: content %v: got %q, want %q", c.content, got, c.want)
		}
	}
	later := &ClaudeRequest{MaxTokens: 16, Messages: []ClaudeMessage{
		{Role: "user", Content: "hi"}, {Role: "assistant", Content: "hello"}, {Role: "user", Content: 7.0},
	}}
	if got, want := validateClaudeRequestShape(later), "messages.2.content must be a string or an array of content blocks, not a number"; got != want {
		t.Errorf("third message: got %q, want %q", got, want)
	}
	for _, ok := range []interface{}{"hi", []interface{}{map[string]interface{}{"type": "text", "text": "hi"}}} {
		if got := validateClaudeRequestShape(&ClaudeRequest{MaxTokens: 16, Messages: []ClaudeMessage{{Role: "user", Content: ok}}}); got != "" {
			t.Errorf("content %v refused: %q", ok, got)
		}
	}
}

func TestChatContentTypeIsNamed(t *testing.T) {
	req := &OpenAIRequest{Messages: []OpenAIMessage{{Role: "user", Content: 5.0}}}
	if got, want := validateOpenAIRequestShape(req), "messages[0].content must be a string or an array of content parts, not a number"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	//! An assistant turn that only calls tools carries null content.
	ok := &OpenAIRequest{Messages: []OpenAIMessage{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: nil, ToolCalls: []ToolCall{{ID: "c1", Type: "function"}}},
		{Role: "tool", ToolCallID: "c1", Content: "done"},
	}}
	if got := validateOpenAIRequestShape(ok); got != "" {
		t.Errorf("null assistant content refused: %q", got)
	}
}

func TestChatMaxCompletionTokensIsNamed(t *testing.T) {
	if got, want := validateOpenAIRequestShape(&OpenAIRequest{MaxCompletionTokens: -1, Messages: []OpenAIMessage{{Role: "user", Content: "hi"}}}),
		"max_completion_tokens must be a positive number"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got, want := validateOpenAIRequestShape(&OpenAIRequest{MaxTokens: -1, Messages: []OpenAIMessage{{Role: "user", Content: "hi"}}}),
		"max_tokens must be a positive number"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// The Responses API names its own fields: input[i], not the messages[i] it is turned into.
func TestResponsesValidationNamesInputFields(t *testing.T) {
	cases := []struct {
		name, body, want string
	}{
		{"role", `{"model":"m","input":[{"role":"wizard","content":"hi"}]}`,
			`input[0].role must be one of user, assistant, system or developer, got "wizard"`},
		{"role after instructions", `{"model":"m","instructions":"be brief","input":[{"role":"user","content":"hi"},{"type":"message","role":"robot","content":"x"}]}`,
			`input[1].role must be one of user, assistant, system or developer, got "robot"`},
		{"content number", `{"model":"m","input":[{"role":"user","content":5}]}`,
			"input[0].content must be a string or an array of content parts, not a number"},
		{"item not object", `{"model":"m","input":["hi"]}`,
			"input[0] must be an object, not a string"},
		{"custom tool input", `{"model":"m","input":[{"role":"user","content":"hi"},{"type":"custom_tool_call","call_id":"c","name":"t","input":5}]}`,
			"input[1].input must be a string"},
		{"agent message", `{"model":"m","input":[{"type":"agent_message","content":[]}]}`,
			"input[0].content must hold text for an agent_message"},
		{"input type", `{"model":"m","input":5}`,
			"input must be a string or an array, not a number"},
		{"max_output_tokens", `{"model":"m","max_output_tokens":-1,"input":"hi"}`,
			"max_output_tokens must be a positive number"},
		{"only system", `{"model":"m","input":[{"role":"developer","content":"rules"}]}`,
			"input needs at least one item that is not a system or developer message"},
		{"prefill", `{"model":"m","input":[{"role":"user","content":"hi"},{"role":"assistant","content":"Sure"}]}`,
			"input must not end with an assistant message: prefill is not supported"},
		{"empty user", `{"model":"m","input":[{"role":"user","content":""},{"type":"function_call_output","call_id":"c","output":"x"}]}`,
			"input needs at least one user message with content"},
	}
	for _, c := range cases {
		var req OpenAIResponsesRequest
		if err := json.Unmarshal([]byte(c.body), &req); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		_, got := prepareResponsesRequest(&req, nil)
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// The OpenAI error body's param names the Responses field.
func TestResponsesRoleErrorParamIsInput(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Handler{}).sendOpenAIError(rec, http.StatusBadRequest, "invalid_request_error", `input[0].role must be one of user, assistant, system or developer, got "wizard"`)
	var body struct {
		Error map[string]interface{} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error["param"] != "input" {
		t.Errorf("param = %v, want input", body.Error["param"])
	}
	rec = httptest.NewRecorder()
	(&Handler{}).sendOpenAIError(rec, http.StatusBadRequest, "invalid_request_error", "max_output_tokens must be a positive number")
	body.Error = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error["param"] != "max_output_tokens" {
		t.Errorf("param = %v, want max_output_tokens", body.Error["param"])
	}
}
