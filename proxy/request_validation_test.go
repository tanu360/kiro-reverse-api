package proxy

import (
	"context"
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
		`{"model":"x","messages":[{"role":true}]}`:                            "Invalid JSON: messages.0.role must be a string, not a boolean",
		`{"model":"x","messages":[{"role":"user","content":"a"},{"role":7}]}`: "Invalid JSON: messages.1.role must be a string, not a number",
		`{"model":"x","stop_sequences":["a",2]}`:                              "Invalid JSON: stop_sequences.1 must be a string, not a number",
	}
	for body, want := range cases {
		var req ClaudeRequest
		err := json.Unmarshal([]byte(body), &req)
		got := clientJSONError(err, []byte(body))
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
		{ClaudeRequest{Model: "m", MaxTokens: -1, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}, "max_tokens must be at least 1"},
		{ClaudeRequest{Model: "m", Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}, ""},
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

// withModelMaxOutput records a model's token limits as ListAvailableModels does, until the test ends.
func withModelMaxOutput(t *testing.T, model string, maxOutput int) {
	t.Helper()
	recordUpstreamMaxOutputTokens([]ModelInfo{{ModelId: model, TokenLimits: &struct {
		MaxInputTokens  int `json:"maxInputTokens"`
		MaxOutputTokens int `json:"maxOutputTokens"`
	}{MaxInputTokens: 200000, MaxOutputTokens: maxOutput}}})
	t.Cleanup(func() { upstreamMaxOutputTokens.Delete(strings.ToLower(model)) })
}

func hiMessage() []ClaudeMessage {
	return []ClaudeMessage{{Role: "user", Content: "hi"}}
}

// Without max_tokens (absent and 0 decode alike) a request gets the model's maximum output.
func TestMessagesWithoutMaxTokensGetTheModelMaximum(t *testing.T) {
	withModelMaxOutput(t, "claude-sonnet-4.5", 48000)

	// The client's alias maps to the Kiro model whose limit was recorded.
	req := ClaudeRequest{Model: "claude-sonnet-4-5", Messages: hiMessage()}
	if msg := validateClaudeRequestShape(&req); msg != "" {
		t.Fatalf("no max_tokens: got %q, want it accepted", msg)
	}
	if req.MaxTokens != 48000 {
		t.Fatalf("filled max_tokens = %d, want the model's 48000", req.MaxTokens)
	}

	req = ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 8, Messages: hiMessage()}
	if msg := validateClaudeRequestShape(&req); msg != "" || req.MaxTokens != 8 {
		t.Fatalf("explicit max_tokens: got %q and %d, want it kept at 8", msg, req.MaxTokens)
	}

	req = ClaudeRequest{Model: "model-no-account-lists", Messages: hiMessage()}
	if msg := validateClaudeRequestShape(&req); msg != "" || req.MaxTokens != defaultMaxOutputTokens {
		t.Fatalf("unknown model: got %q and %d, want the fallback %d", msg, req.MaxTokens, defaultMaxOutputTokens)
	}
}

func TestMessagesNegativeMaxTokensIsRejected(t *testing.T) {
	req := ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: -1, Messages: hiMessage()}
	if got := validateClaudeRequestShape(&req); got != "max_tokens must be at least 1" {
		t.Fatalf("max_tokens -1: got %q", got)
	}
}

// The thinking budget is checked against the filled-in maximum.
func TestMessagesWithoutMaxTokensCheckTheThinkingBudgetAgainstTheModelMaximum(t *testing.T) {
	withModelMaxOutput(t, "claude-sonnet-4.5", 32000)
	check := func(budget int, interleaved bool) string {
		req := ClaudeRequest{
			Model:               "claude-sonnet-4.5",
			Messages:            hiMessage(),
			Thinking:            &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: budget},
			interleavedThinking: interleaved,
		}
		return validateClaudeRequestShape(&req)
	}
	if got := check(16000, false); got != "" {
		t.Fatalf("budget 16000 under a 32000 maximum: got %q", got)
	}
	if got := check(32000, false); got != "thinking.budget_tokens must be less than max_tokens (not set, so the model's maximum of 32000)" {
		t.Fatalf("budget 32000 at the 32000 maximum: got %q", got)
	}
	if got := check(32000, true); got != "" {
		t.Fatalf("interleaved budget 32000: got %q", got)
	}
}

// A max_tokens the proxy filled in is not the client's limit: the output limiter must never
// cut the reply at it, even when the model's recorded maximum is small.
func TestDefaultedMaxTokensNeverCutTheReply(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	withModelMaxOutput(t, "claude-sonnet-4.5", 50)
	essay := strings.Repeat("Bridges carry roads over rivers and valleys. ", 40)

	req := &ClaudeRequest{Model: "claude-sonnet-4.5", Messages: hiMessage()}
	if msg := validateClaudeRequestShape(req); msg != "" {
		t.Fatalf("validate: %q", msg)
	}
	payload := ClaudeToKiro(req, false)
	if got := requestedMaxTokens(payload); got != 0 {
		t.Fatalf("payload max tokens = %d, want none", got)
	}
	stream := &limitedStream{text: []string{essay[:300], essay[300:]}}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, payload, rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if stream.cancelled || rec.text != essay || rec.stop != "end_turn" {
		t.Fatalf("reply cut: cancelled %t, stop %q, %d of %d bytes", stream.cancelled, rec.stop, len(rec.text), len(essay))
	}

	// The same reply with the client's own max_tokens of 50 is cut.
	req = &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 50, Messages: hiMessage()}
	if msg := validateClaudeRequestShape(req); msg != "" {
		t.Fatalf("validate: %q", msg)
	}
	stream = &limitedStream{text: []string{essay[:300], essay[300:]}}
	rec = &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, ClaudeToKiro(req, false), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if rec.stop != "max_tokens" || len(rec.text) >= len(essay) {
		t.Fatalf("explicit max_tokens 50: stop %q, %d bytes, want a cut", rec.stop, len(rec.text))
	}
}

// End to end: all three chat APIs answer a request without an output limit, whole.
func TestRequestsWithoutAnOutputLimitAnswerWhole(t *testing.T) {
	essay := strings.TrimSpace(strings.Repeat("Bridges carry roads over rivers and valleys. ", 40))
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, essay)
	})
	withModelMaxOutput(t, "claude-sonnet-4.5", 50)
	post := func(path, body string) string {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: status %d body %s", path, body, rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}

	for _, body := range []string{
		`{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"claude-sonnet-4.5","max_tokens":0,"messages":[{"role":"user","content":"hi"}]}`,
	} {
		var msg struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			StopReason string `json:"stop_reason"`
		}
		if err := json.Unmarshal([]byte(post("/v1/messages", body)), &msg); err != nil {
			t.Fatal(err)
		}
		if len(msg.Content) != 1 || msg.Content[0].Text != essay || msg.StopReason != "end_turn" {
			t.Fatalf("messages %s: stop %q, content %+v", body, msg.StopReason, msg.Content)
		}
	}
	stream := post("/v1/messages", `{"model":"claude-sonnet-4.5","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if !strings.Contains(stream, `"stop_reason":"end_turn"`) {
		t.Fatalf("streamed messages did not end with end_turn: %s", stream)
	}

	var chat struct {
		Choices []struct {
			Message      struct{ Content string } `json:"message"`
			FinishReason string                   `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal([]byte(post("/v1/chat/completions", `{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}`)), &chat); err != nil {
		t.Fatal(err)
	}
	if len(chat.Choices) != 1 || chat.Choices[0].Message.Content != essay || chat.Choices[0].FinishReason != "stop" {
		t.Fatalf("chat completions: %+v", chat.Choices)
	}

	responses := post("/v1/responses", `{"model":"claude-sonnet-4.5","input":"hi","store":false}`)
	if !strings.Contains(responses, essay) || !strings.Contains(responses, `"status":"completed"`) {
		t.Fatalf("responses: %s", responses)
	}
}
