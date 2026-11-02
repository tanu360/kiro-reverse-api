package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type scriptedHop struct {
	thinking []string
	text     []string
	tools    []KiroToolUse
	stop     string
	in, out  int
	credits  float64
	cache    [2]int
	err      error
}

type scriptedKiro struct {
	hops     []scriptedHop
	payloads []*KiroPayload
}

func (s *scriptedKiro) call(_ context.Context, _ *config.Account, payload *KiroPayload, cb *KiroStreamCallback) error {
	hop := s.hops[len(s.payloads)]
	s.payloads = append(s.payloads, payload)
	for _, text := range hop.thinking {
		cb.OnText(text, true)
	}
	for _, text := range hop.text {
		cb.OnText(text, false)
	}
	for _, tool := range hop.tools {
		cb.OnToolUse(tool)
	}
	if hop.err != nil {
		return hop.err
	}
	cb.OnStopReason(hop.stop)
	if hop.credits > 0 {
		cb.OnCredits(hop.credits)
	}
	if hop.cache != [2]int{} && cb.OnCacheUsage != nil {
		cb.OnCacheUsage(hop.cache[0], hop.cache[1])
	}
	cb.OnComplete(hop.in, hop.out)
	return nil
}

type continueRecorder struct {
	text, thinking string
	tools          []KiroToolUse
	stop           string
	stopCalls      int
	in, out        int
	credits        float64
	cache          [2]int
	cacheCalls     int
}

func (r *continueRecorder) callback() *KiroStreamCallback {
	return &KiroStreamCallback{
		OnText: func(text string, isThinking bool) {
			if isThinking {
				r.thinking += text
			} else {
				r.text += text
			}
		},
		OnToolUse:    func(tu KiroToolUse) { r.tools = append(r.tools, tu) },
		OnStopReason: func(reason string) { r.stop = reason; r.stopCalls++ },
		OnCredits:    func(c float64) { r.credits = c },
		OnCacheUsage: func(read, write int) { r.cache = [2]int{read, write}; r.cacheCalls++ },
		OnComplete:   func(in, out int) { r.in, r.out = in, out },
	}
}

func runScriptedContinue(t *testing.T, payload *KiroPayload, maxContinuations int, hops ...scriptedHop) (*continueRecorder, *scriptedKiro, error) {
	t.Helper()
	script := &scriptedKiro{hops: hops}
	rec := &continueRecorder{}
	err := runAutoContinue(context.Background(), nil, payload, rec.callback(), script.call, maxContinuations)
	return rec, script, err
}

func TestAutoContinueAppendsContinuationToSameAnswer(t *testing.T) {
	payload := testKiroPayload()
	rec, script, err := runScriptedContinue(t, payload, 3,
		scriptedHop{text: []string{"Part one, "}, stop: "max_tokens", in: 100, out: 8192, credits: 0.5},
		scriptedHop{text: []string{"part two."}, stop: "end_turn", in: 150, out: 20, credits: 0.25},
	)
	if err != nil {
		t.Fatalf("runAutoContinue: %v", err)
	}
	if len(script.payloads) != 2 {
		t.Fatalf("upstream calls = %d, want 2", len(script.payloads))
	}
	if rec.text != "Part one, part two." {
		t.Fatalf("text = %q", rec.text)
	}
	if rec.stop != "end_turn" || rec.stopCalls != 1 {
		t.Fatalf("stop = %q (%d calls), want the last hop's reason once", rec.stop, rec.stopCalls)
	}
	if rec.in != 250 || rec.out != 8212 || rec.credits != 0.75 {
		t.Fatalf("usage in=%d out=%d credits=%v, want sums across hops", rec.in, rec.out, rec.credits)
	}

	next := script.payloads[1]
	history := next.ConversationState.History
	if len(history) < 2 {
		t.Fatalf("continuation history = %#v", history)
	}
	user, assistant := history[len(history)-2], history[len(history)-1]
	if user.UserInputMessage == nil || user.UserInputMessage.Content != "hello" {
		t.Fatalf("history must replay the original user turn, got %#v", user)
	}
	if assistant.AssistantResponseMessage == nil || assistant.AssistantResponseMessage.Content != "Part one, " {
		t.Fatalf("history must hold the partial answer, got %#v", assistant)
	}
	if got := next.ConversationState.CurrentMessage.UserInputMessage.Content; got != autoContinuePrompt {
		t.Fatalf("continuation prompt = %q", got)
	}
	if len(payload.ConversationState.History) != 0 || payload.ConversationState.CurrentMessage.UserInputMessage.Content != "hello" {
		t.Fatalf("the original payload must stay untouched")
	}
}

func TestAutoContinueAcceptsEveryOutputCapSpelling(t *testing.T) {
	for _, reason := range []string{"max_tokens", "MAX_TOKENS", "length", "max_output_tokens"} {
		_, script, err := runScriptedContinue(t, testKiroPayload(), 3,
			scriptedHop{text: []string{"a"}, stop: reason},
			scriptedHop{text: []string{"b"}, stop: "end_turn"},
		)
		if err != nil || len(script.payloads) != 2 {
			t.Fatalf("reason %q: calls=%d err=%v, want a continuation", reason, len(script.payloads), err)
		}
	}
}

func TestAutoContinueStopsAtConfiguredCap(t *testing.T) {
	capped := scriptedHop{text: []string{"more "}, stop: "max_tokens"}
	rec, script, err := runScriptedContinue(t, testKiroPayload(), 2, capped, capped, capped, capped)
	if err != nil {
		t.Fatalf("runAutoContinue: %v", err)
	}
	if len(script.payloads) != 3 {
		t.Fatalf("upstream calls = %d, want 1 + 2 continuations", len(script.payloads))
	}
	if rec.stop != "max_tokens" || rec.text != "more more more " {
		t.Fatalf("stop=%q text=%q", rec.stop, rec.text)
	}
	if got := script.payloads[2].ConversationState.History; got[len(got)-1].AssistantResponseMessage.Content != "more more " {
		t.Fatalf("later continuations carry the whole answer so far, got %#v", got[len(got)-1])
	}
}

func TestAutoContinueSkipsTurnsThatCallTools(t *testing.T) {
	rec, script, err := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"calling"}, tools: []KiroToolUse{{ToolUseID: "t1", Name: "Read"}}, stop: "max_tokens"},
		scriptedHop{text: []string{"never"}, stop: "end_turn"},
	)
	if err != nil || len(script.payloads) != 1 || len(rec.tools) != 1 {
		t.Fatalf("calls=%d tools=%d err=%v, want no continuation after a tool call", len(script.payloads), len(rec.tools), err)
	}
}

func TestAutoContinueSkipsOtherStopReasons(t *testing.T) {
	for _, reason := range []string{"", "end_turn", "stop_sequence", "content_filter"} {
		_, script, _ := runScriptedContinue(t, testKiroPayload(), 3,
			scriptedHop{text: []string{"done"}, stop: reason},
			scriptedHop{text: []string{"never"}, stop: "end_turn"},
		)
		if len(script.payloads) != 1 {
			t.Fatalf("reason %q continued", reason)
		}
	}
}

func TestAutoContinueDoesNotResumeInsideThinking(t *testing.T) {
	rec, script, _ := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"<thinking>still reasoning"}, stop: "max_tokens"},
		scriptedHop{text: []string{"never"}, stop: "end_turn"},
	)
	if len(script.payloads) != 1 || rec.stop != "max_tokens" {
		t.Fatalf("calls=%d stop=%q, a turn cut inside thinking must end as is", len(script.payloads), rec.stop)
	}
	_, script, _ = runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{thinking: []string{"only reasoning"}, stop: "max_tokens"},
		scriptedHop{text: []string{"never"}, stop: "end_turn"},
	)
	if len(script.payloads) != 1 {
		t.Fatalf("a turn without answer text must not continue")
	}
}

func TestAutoContinueDropsReasoningFromContinuations(t *testing.T) {
	rec, script, err := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{thinking: []string{"plan"}, text: []string{"<thinking>inline</thinking>Answer "}, stop: "max_tokens"},
		scriptedHop{thinking: []string{"again"}, text: []string{"<thinking>re", "think</thinking>", "goes on."}, stop: "end_turn"},
	)
	if err != nil || len(script.payloads) != 2 {
		t.Fatalf("calls=%d err=%v", len(script.payloads), err)
	}
	if rec.thinking != "plan" {
		t.Fatalf("thinking = %q, want only the first hop's reasoning", rec.thinking)
	}
	if rec.text != "<thinking>inline</thinking>Answer goes on." {
		t.Fatalf("text = %q, want the first hop raw and the continuation without thinking", rec.text)
	}
	history := script.payloads[1].ConversationState.History
	if got := history[len(history)-1].AssistantResponseMessage.Content; got != "Answer " {
		t.Fatalf("partial answer = %q, want answer text without thinking", got)
	}
}

func TestAutoContinueEndsWithPartialAnswerWhenContinuationFails(t *testing.T) {
	rec, script, err := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"Part one, "}, stop: "max_tokens", in: 10, out: 8192},
		scriptedHop{text: []string{"par"}, err: errUpstreamTruncatedResponse},
	)
	if err != nil {
		t.Fatalf("a failed continuation must not fail the answer, got %v", err)
	}
	if len(script.payloads) != 2 || rec.text != "Part one, par" {
		t.Fatalf("calls=%d text=%q", len(script.payloads), rec.text)
	}
	if rec.stop != "max_tokens" || rec.out != 8192 {
		t.Fatalf("stop=%q out=%d, want the last completed hop", rec.stop, rec.out)
	}
}

func TestAutoContinuePropagatesFirstHopErrorAndClientCancel(t *testing.T) {
	boom := errors.New("boom")
	_, _, err := runScriptedContinue(t, testKiroPayload(), 3, scriptedHop{err: boom})
	if !errors.Is(err, boom) {
		t.Fatalf("first hop error = %v, want it returned for the handler's retry logic", err)
	}
	_, _, err = runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"a"}, stop: "max_tokens"},
		scriptedHop{err: context.Canceled},
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("client cancel = %v, want context.Canceled", err)
	}
}

func TestAutoContinueRespectsClientOutputBudget(t *testing.T) {
	payload := testKiroPayload()
	payload.InferenceConfig = &InferenceConfig{MaxTokens: 10000, Temperature: 0.5}
	_, script, _ := runScriptedContinue(t, payload, 3,
		scriptedHop{text: []string{"a"}, stop: "max_tokens", out: 8192},
		scriptedHop{text: []string{"b"}, stop: "end_turn"},
	)
	if len(script.payloads) != 2 {
		t.Fatalf("calls = %d, want a continuation within budget", len(script.payloads))
	}
	if got := script.payloads[1].InferenceConfig; got == nil || got.MaxTokens != 1808 || got.Temperature != 0.5 {
		t.Fatalf("continuation inference config = %#v, want the remaining budget", got)
	}
	if payload.InferenceConfig.MaxTokens != 10000 {
		t.Fatalf("the original inference config must stay untouched")
	}

	payload.InferenceConfig.MaxTokens = 8192
	_, script, _ = runScriptedContinue(t, payload, 3,
		scriptedHop{text: []string{"a"}, stop: "max_tokens", out: 8192},
		scriptedHop{text: []string{"b"}, stop: "end_turn"},
	)
	if len(script.payloads) != 1 {
		t.Fatalf("a turn that used the client's whole max_tokens must not continue")
	}
}

func TestAutoContinueKeepsDeclaredToolsAndMovesToolResultsToHistory(t *testing.T) {
	payload := markupTestPayload()
	ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
	ctx.ToolResults = []KiroToolResult{{ToolUseID: "t1", Status: "success", Content: []KiroResultContent{{Text: "file body"}}}}
	payload.ConversationState.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{Content: "read it"}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{ToolUses: []KiroToolUse{{ToolUseID: "t1", Name: "read_file", Input: map[string]interface{}{}}}}},
	}
	_, script, _ := runScriptedContinue(t, payload, 3,
		scriptedHop{text: []string{"Summary "}, stop: "max_tokens"},
		scriptedHop{text: []string{"end"}, stop: "end_turn"},
	)
	next := script.payloads[1]
	current := next.ConversationState.CurrentMessage.UserInputMessage
	if current.UserInputMessageContext == nil || len(current.UserInputMessageContext.Tools) != 1 || len(current.UserInputMessageContext.ToolResults) != 0 {
		t.Fatalf("continuation context = %#v, want declared tools only", current.UserInputMessageContext)
	}
	if len(ctx.ToolResults) != 1 || payload.ConversationState.History[1].AssistantResponseMessage.ToolUses == nil {
		t.Fatalf("the original payload's tool state must stay untouched")
	}
	for _, msg := range next.ConversationState.History {
		if msg.UserInputMessage != nil && msg.UserInputMessage.UserInputMessageContext != nil && len(msg.UserInputMessage.UserInputMessageContext.Tools) > 0 {
			t.Fatalf("history turns must not redeclare tools: %#v", msg.UserInputMessage)
		}
	}
}

func TestCallKiroAutoContinueIsOffByDefault(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	script := &scriptedKiro{hops: []scriptedHop{
		{text: []string{"a"}, stop: "max_tokens"},
		{text: []string{"b"}, stop: "end_turn"},
	}}
	rec := &continueRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, testKiroPayload(), rec.callback(), script.call); err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 1 || rec.stop != "max_tokens" {
		t.Fatalf("calls=%d stop=%q, want a plain single call while disabled", len(script.payloads), rec.stop)
	}
}

// continuationUpstream answers the first request with a capped turn and the second with the rest.
func continuationUpstream(t *testing.T, bodies *[]string) http.HandlerFunc {
	var mu sync.Mutex
	var calls atomic.Int32
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		*bodies = append(*bodies, string(body))
		mu.Unlock()
		if calls.Add(1) == 1 {
			writeFrames(w,
				awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "The first half of a long answer, "}),
				awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "max_tokens", "usage": map[string]interface{}{"inputTokens": 100, "outputTokens": 8192}}),
			)
			return
		}
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "and the second half."}),
			awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn", "usage": map[string]interface{}{"inputTokens": 130, "outputTokens": 40}}),
		)
	}
}

const continuedAnswer = "The first half of a long answer, and the second half."

func enableAutoContinueForTest(t *testing.T) {
	t.Helper()
	if err := config.UpdateAutoContinue(true); err != nil {
		t.Fatalf("enable auto-continue: %v", err)
	}
}

func TestClaudeNonStreamAutoContinuesCappedAnswer(t *testing.T) {
	var bodies []string
	h := newStreamTestHandler(t, continuationUpstream(t, &bodies))
	enableAutoContinueForTest(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	var resp ClaudeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if len(bodies) != 2 || !strings.Contains(bodies[1], "The first half of a long answer, ") {
		t.Fatalf("upstream bodies = %d, want a continuation carrying the partial answer", len(bodies))
	}
	if len(resp.Content) != 1 || resp.Content[0].Text != continuedAnswer {
		t.Fatalf("content = %#v, want one concatenated text block", resp.Content)
	}
	if resp.StopReason != "end_turn" || resp.Usage.OutputTokens != 8232 || resp.Usage.InputTokens != 230 {
		t.Fatalf("stop=%q usage=%#v", resp.StopReason, resp.Usage)
	}
}

func TestClaudeStreamAutoContinuesInSameTextBlock(t *testing.T) {
	var bodies []string
	h := newStreamTestHandler(t, continuationUpstream(t, &bodies))
	enableAutoContinueForTest(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	h.handleClaudeStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	body := rec.Body.String()
	if got := collectClaudeTextDeltas(t, body); got != continuedAnswer {
		t.Fatalf("text = %q", got)
	}
	if n := strings.Count(body, "event: content_block_start"); n != 1 {
		t.Fatalf("content blocks = %d, want the continuation inside the first block; body=%s", n, body)
	}
	if !strings.Contains(body, `"stop_reason":"end_turn"`) || !strings.Contains(body, "event: message_stop") {
		t.Fatalf("expected end_turn and message_stop, body=%s", body)
	}
}

func TestOpenAIAutoContinuesCappedAnswer(t *testing.T) {
	var bodies []string
	h := newStreamTestHandler(t, continuationUpstream(t, &bodies))
	enableAutoContinueForTest(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	h.handleOpenAIStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)
	body := rec.Body.String()
	if got := collectOpenAIContentDeltas(t, body); got != continuedAnswer {
		t.Fatalf("stream text = %q", got)
	}
	if !strings.Contains(body, `"finish_reason":"stop"`) {
		t.Fatalf("expected finish_reason stop, body=%s", body)
	}

	bodies = nil
	h = newStreamTestHandler(t, continuationUpstream(t, &bodies))
	enableAutoContinueForTest(t)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	h.handleOpenAINonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)
	var resp struct {
		Choices []struct {
			Message      struct{ Content string } `json:"message"`
			FinishReason string                   `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Choices) != 1 {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if resp.Choices[0].Message.Content != continuedAnswer || resp.Choices[0].FinishReason != "stop" {
		t.Fatalf("choice = %#v", resp.Choices[0])
	}
}

func TestAutoContinueSettingsRoundTrip(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}

	rec := httptest.NewRecorder()
	h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(`{"autoContinue":true,"autoContinueMax":5}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.apiGetSettings(rec, httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil))
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["autoContinue"] != true || got["autoContinueMax"] != float64(5) {
		t.Fatalf("settings = %#v", got)
	}

	for _, bad := range []string{`{"autoContinueMax":0}`, `{"autoContinueMax":11}`} {
		rec = httptest.NewRecorder()
		h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(bad)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d, want 400", bad, rec.Code)
		}
	}
	if config.GetAutoContinueMax() != 5 {
		t.Fatalf("a rejected update must not change the cap, got %d", config.GetAutoContinueMax())
	}
}

func TestResponsesAutoContinuesCappedAnswer(t *testing.T) {
	var bodies []string
	h := newStreamTestHandler(t, continuationUpstream(t, &bodies))
	enableAutoContinueForTest(t)

	prepared := &responsesPreparedRequest{OpenAIRequest: OpenAIRequest{Model: "claude-sonnet-4.5"}}
	rec := httptest.NewRecorder()
	h.handleOpenAIResponsesNonStream(context.Background(), rec, testKiroPayload(), prepared, false, 1, nil)

	var resp struct {
		Status     string `json:"status"`
		OutputText string `json:"output_text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if len(bodies) != 2 || resp.OutputText != continuedAnswer || resp.Status != "completed" {
		t.Fatalf("calls=%d response=%#v body=%s", len(bodies), resp, rec.Body.String())
	}
}

func TestAutoContinuePayloadKeepsStructuredToolHistory(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)

	var tool KiroToolWrapper
	tool.ToolSpecification.Name = "readFile"
	base := &KiroPayload{}
	base.ConversationState.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{Content: "read a.txt"}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{ToolUses: []KiroToolUse{{ToolUseID: "t1", Name: "readFile", Input: map[string]interface{}{"path": "a.txt"}}}}},
	}
	base.ConversationState.CurrentMessage.UserInputMessage = KiroUserInputMessage{
		Content: "summarize it",
		UserInputMessageContext: &UserInputMessageContext{
			Tools:       []KiroToolWrapper{tool},
			ToolResults: []KiroToolResult{{ToolUseID: "t1", Status: "success", Content: []KiroResultContent{{Text: "hello"}}}},
		},
	}

	next := buildContinuationPayload(base, "partial answer", 100)

	uses, results := 0, 0
	for _, msg := range next.ConversationState.History {
		if msg.AssistantResponseMessage != nil {
			uses += len(msg.AssistantResponseMessage.ToolUses)
		}
		if msg.UserInputMessage != nil && msg.UserInputMessage.UserInputMessageContext != nil {
			results += len(msg.UserInputMessage.UserInputMessageContext.ToolResults)
		}
	}
	if uses != 1 || results != 1 {
		t.Fatalf("continuation history narrated the tool pair: toolUses=%d toolResults=%d", uses, results)
	}
}

func TestAutoContinueSumsCacheUsageAcrossHops(t *testing.T) {
	rec, _, err := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"Part one, "}, stop: "max_tokens", in: 100, out: 8192, cache: [2]int{80, 10}},
		scriptedHop{text: []string{"part two."}, stop: "end_turn", in: 150, out: 20, cache: [2]int{120, 20}},
	)
	if err != nil {
		t.Fatalf("runAutoContinue: %v", err)
	}
	if rec.in != 250 || rec.cache != [2]int{200, 30} || rec.cacheCalls != 1 {
		t.Fatalf("in=%d cache=%v (%d calls), want cache summed like input and reported once", rec.in, rec.cache, rec.cacheCalls)
	}
}

func TestAutoContinueInfersCapWhenUpstreamSendsNoStopReason(t *testing.T) {
	rec, script, err := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"Part one, "}, in: 100, out: 8192},
		scriptedHop{text: []string{"part two."}, in: 150, out: 20},
	)
	if err != nil {
		t.Fatalf("runAutoContinue: %v", err)
	}
	if len(script.payloads) != 2 || rec.text != "Part one, part two." {
		t.Fatalf("calls=%d text=%q, want a continuation after a stop-reason-less hop at the cap", len(script.payloads), rec.text)
	}
}

func TestAutoContinueDoesNotContinueShortAnswerWithoutStopReason(t *testing.T) {
	_, script, err := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"Done."}, in: 100, out: 900},
	)
	if err != nil {
		t.Fatalf("runAutoContinue: %v", err)
	}
	if len(script.payloads) != 1 {
		t.Fatalf("calls=%d, a short answer without a stop reason is finished", len(script.payloads))
	}
}
