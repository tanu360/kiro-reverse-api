package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-proxy/config"
)

func TestClientJSONErrorHidesGoTypes(t *testing.T) {
	cases := map[string]string{
		`{"model":"x","messages":"hi"}`:  "Invalid JSON: messages must be an array, not a string",
		`{"model":"x","max_tokens":"8"}`: "Invalid JSON: max_tokens must be a whole number, not a string",
		`{"model":1}`:                    "Invalid JSON: model must be a string, not a number",
		`[]`:                             "Invalid JSON: the body must be an object, not an array",
		`{"model":`:                      "Invalid JSON: the body ends too early",
		`{"model": x}`:                   "Invalid JSON at byte",
		`{"model":"x","messages":[{"role":true}]}`: "Invalid JSON: messages.0.role must be a string, not a boolean",
	}
	for body, want := range cases {
		var req ClaudeRequest
		err := json.Unmarshal([]byte(body), &req)
		got := clientJSONError(err)
		if !strings.HasPrefix(got, want) || strings.Contains(got, "Go ") || strings.Contains(got, "proxy.") {
			t.Fatalf("%s: got %q, want %q", body, got, want)
		}
	}
}

func TestMessagesValidationMatchesTheAPI(t *testing.T) {
	cases := []struct {
		req  ClaudeRequest
		want string
	}{
		{ClaudeRequest{Model: "m", Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}, "max_tokens is required"},
		{ClaudeRequest{Model: "m", MaxTokens: 8, Messages: []ClaudeMessage{{Role: "robot", Content: "hi"}}}, `messages.0.role must be "user" or "assistant", got "robot"`},
		{ClaudeRequest{Model: "m", MaxTokens: 8, Messages: []ClaudeMessage{{Role: "system", Content: "be brief"}, {Role: "user", Content: "hi"}}}, ""},
		{ClaudeRequest{Model: "m", MaxTokens: 1500, Thinking: &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 4000}, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}, "thinking.budget_tokens must be less than max_tokens"},
		{ClaudeRequest{Model: "m", MaxTokens: 1500, interleavedThinking: true, Thinking: &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 4000}, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}, ""},
	}
	for i, c := range cases {
		got := validateClaudeRequestShape(&c.req)
		if (c.want == "" && got != "") || (c.want != "" && !strings.HasPrefix(got, c.want)) {
			t.Fatalf("case %d: got %q, want %q", i, got, c.want)
		}
	}
	if got := validateOpenAIRequestShape(&OpenAIRequest{Messages: []OpenAIMessage{{Role: "wizard", Content: "hi"}}}); !strings.Contains(got, `got "wizard"`) {
		t.Fatalf("openai role: %q", got)
	}
	if got := validateOpenAIRequestShape(&OpenAIRequest{Messages: []OpenAIMessage{{Role: "developer", Content: "x"}, {Role: "user", Content: "hi"}}}); got != "" {
		t.Fatalf("developer role refused: %q", got)
	}
}

func TestInterleavedThinkingNeedsTheBetaAndAModelWithIt(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	req := func(beta string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
		if beta != "" {
			r.Header.Set("anthropic-beta", beta)
		}
		return r
	}
	cases := []struct {
		beta, model string
		want        bool
	}{
		{"interleaved-thinking-2025-05-14", "claude-sonnet-4.5", true},
		{"fine-grained-tool-streaming-2025-05-14, interleaved-thinking-2025-05-14", "claude-opus-4-5-20251101", true},
		{"interleaved-thinking-2025-05-14", "claude-haiku-4.5", false},
		{"interleaved-thinking-2025-05-14", "deepseek-3.2", false},
		{"", "claude-sonnet-4.5", false},
	}
	for _, c := range cases {
		if got := claudeInterleavedThinking(req(c.beta), c.model); got != c.want {
			t.Fatalf("%q %s: got %t", c.beta, c.model, got)
		}
	}
}
