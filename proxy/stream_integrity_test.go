package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func parseFrames(t *testing.T, callback *KiroStreamCallback, frames ...[]byte) error {
	t.Helper()
	return parseEventStream(bytes.NewReader(bytes.Join(frames, nil)), callback)
}

func TestParseEventStreamRejectsAnswerWithoutEndSignal(t *testing.T) {
	var completed bool
	err := parseFrames(t, &KiroStreamCallback{OnComplete: func(_, _ int) { completed = true }},
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "half an ans"}),
	)
	if !errors.Is(err, errUpstreamTruncatedResponse) {
		t.Fatalf("expected truncated response error, got %v", err)
	}
	if completed {
		t.Fatalf("OnComplete must not run for a truncated stream")
	}
}

func TestParseEventStreamAcceptsStopReasonWithoutTrailer(t *testing.T) {
	var stopReason string
	err := parseFrames(t, &KiroStreamCallback{OnStopReason: func(reason string) { stopReason = reason }},
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "done"}),
		awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "max_tokens"}),
	)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if stopReason != "max_tokens" {
		t.Fatalf("stop reason = %q, want max_tokens", stopReason)
	}
}

func TestParseEventStreamAcceptsTrailerWithoutStopReason(t *testing.T) {
	//! IdC / Enterprise accounts never send metadataEvent (upstream Kiro-Go #147, #158).
	for _, trailer := range []string{"meteringEvent"} {
		t.Run(trailer, func(t *testing.T) {
			err := parseFrames(t, &KiroStreamCallback{},
				awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "done"}),
				awsEventStreamFrame(t, trailer, map[string]interface{}{"usage": 0.01, "contextUsagePercentage": 1.0}),
			)
			if err != nil {
				t.Fatalf("expected %s to end the turn, got %v", trailer, err)
			}
		})
	}
}

func TestParseEventStreamReasoningWithoutAnswerIsTruncated(t *testing.T) {
	err := parseFrames(t, &KiroStreamCallback{},
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "thinking..."}),
		meteringFrame(t),
	)
	if !errors.Is(err, errUpstreamTruncatedResponse) {
		t.Fatalf("expected truncated response error, got %v", err)
	}
}

func TestParseEventStreamWithoutOutputIsEmpty(t *testing.T) {
	for name, frames := range map[string][][]byte{
		"no frames":    nil,
		"trailer only": {meteringFrame(t)},
	} {
		t.Run(name, func(t *testing.T) {
			if err := parseFrames(t, &KiroStreamCallback{}, frames...); !errors.Is(err, errEmptyKiroStream) {
				t.Fatalf("expected empty stream error, got %v", err)
			}
		})
	}
}

func TestParseEventStreamRejectsCorruptFrame(t *testing.T) {
	frame := awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hello"})
	frame[len(frame)-6] ^= 0xff

	var gotText bool
	err := parseFrames(t, &KiroStreamCallback{OnText: func(string, bool) { gotText = true }}, frame)
	if !errors.Is(err, errInvalidKiroEventStream) {
		t.Fatalf("expected invalid event stream error, got %v", err)
	}
	if gotText {
		t.Fatalf("a corrupt frame must not reach the caller")
	}
}

func TestParseEventStreamCutInsideFrameIsTruncation(t *testing.T) {
	complete := awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hello"})
	next := awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": " world"})
	for name, cut := range map[string][]byte{
		"inside prelude": next[:5],
		"inside message": next[:len(next)-3],
	} {
		t.Run(name, func(t *testing.T) {
			err := parseFrames(t, &KiroStreamCallback{}, complete, cut)
			if !errors.Is(err, errUpstreamTruncatedResponse) || !isStreamIntegrityError(err) {
				t.Fatalf("expected a retryable truncation error, got %v", err)
			}
		})
	}
}

func TestParseEventStreamSurfacesExceptionFrame(t *testing.T) {
	err := parseFrames(t, &KiroStreamCallback{},
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "partial"}),
		awsEventStreamFrameWithHeaders(t, map[string]string{
			":message-type":   "exception",
			":exception-type": "ThrottlingException",
		}, map[string]interface{}{"message": "Too many requests"}),
	)
	if !errors.Is(err, errKiroEventStreamUpstream) {
		t.Fatalf("expected upstream event stream error, got %v", err)
	}
	if !strings.Contains(err.Error(), "ThrottlingException: Too many requests") {
		t.Fatalf("expected exception type and message in error, got %q", err)
	}
	if isStreamIntegrityError(err) {
		t.Fatalf("an upstream exception is an account signal, not a stream hiccup")
	}
}

func TestParseEventStreamRejectsIncompleteToolInput(t *testing.T) {
	var toolUses []KiroToolUse
	err := parseFrames(t, &KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { toolUses = append(toolUses, tu) }},
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
			"toolUseId": "toolu_write",
			"name":      "write_file",
			"input":     `{"path":"/tmp/a","content":"unfinish`,
		}),
		meteringFrame(t),
	)
	if !errors.Is(err, errIncompleteKiroToolInput) {
		t.Fatalf("expected incomplete tool input error, got %v", err)
	}
	if len(toolUses) != 0 {
		t.Fatalf("a tool with cut-off arguments must never be emitted, got %#v", toolUses)
	}
}

func TestParseEventStreamKeepsInterleavedParallelTools(t *testing.T) {
	var toolUses []KiroToolUse
	err := parseFrames(t, &KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { toolUses = append(toolUses, tu) }},
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_a", "name": "read", "input": `{"path":`}),
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_b", "name": "grep", "input": `{"pattern":`}),
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_b", "input": `"TODO"}`, "stop": true}),
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_a", "input": `"a.go"}`, "stop": true}),
	)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if len(toolUses) != 2 {
		t.Fatalf("expected two tool uses, got %#v", toolUses)
	}
	if toolUses[0].ToolUseID != "toolu_b" || toolUses[0].Input["pattern"] != "TODO" {
		t.Fatalf("unexpected first finished tool: %#v", toolUses[0])
	}
	if toolUses[1].ToolUseID != "toolu_a" || toolUses[1].Input["path"] != "a.go" {
		t.Fatalf("unexpected second finished tool: %#v", toolUses[1])
	}
}

func TestParseEventStreamFlushesUnstoppedToolsInArrivalOrder(t *testing.T) {
	var ids []string
	err := parseFrames(t, &KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { ids = append(ids, tu.ToolUseID) }},
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_3", "name": "c", "input": `{}`}),
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_1", "name": "a", "input": `{}`}),
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_2", "name": "b", "input": `{}`}),
	)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if strings.Join(ids, ",") != "toolu_3,toolu_1,toolu_2" {
		t.Fatalf("tool order = %v, want arrival order", ids)
	}
}

func TestStopReasonMapping(t *testing.T) {
	cases := []struct {
		reason            string
		toolCount         int
		claude, openai    string
		responsesStatus   string
		responsesIncomplt string
	}{
		{"", 0, "end_turn", "stop", "completed", ""},
		{"end_turn", 0, "end_turn", "stop", "completed", ""},
		{"MAX_TOKENS", 0, "max_tokens", "length", "incomplete", "max_output_tokens"},
		{"model_context_window_exceeded", 0, "model_context_window_exceeded", "length", "incomplete", "max_output_tokens"},
		{"content_filtered", 0, "refusal", "content_filter", "incomplete", "content_filter"},
		{"tool_use", 2, "tool_use", "tool_calls", "completed", ""},
		{"max_tokens", 1, "tool_use", "tool_calls", "incomplete", "max_output_tokens"},
	}
	for _, tc := range cases {
		if got := mapClaudeStopReason(tc.reason, tc.toolCount); got != tc.claude {
			t.Errorf("mapClaudeStopReason(%q, %d) = %q, want %q", tc.reason, tc.toolCount, got, tc.claude)
		}
		if got := mapOpenAIFinishReason(tc.reason, tc.toolCount); got != tc.openai {
			t.Errorf("mapOpenAIFinishReason(%q, %d) = %q, want %q", tc.reason, tc.toolCount, got, tc.openai)
		}
		status, incomplete := mapResponsesCompletion(tc.reason)
		if status != tc.responsesStatus || incomplete != tc.responsesIncomplt {
			t.Errorf("mapResponsesCompletion(%q) = %q/%q, want %q/%q", tc.reason, status, incomplete, tc.responsesStatus, tc.responsesIncomplt)
		}
	}
}

func TestApplyResponsesStopReasonMarksIncomplete(t *testing.T) {
	response := map[string]interface{}{"status": "completed"}
	if event := applyResponsesStopReason(response, "max_tokens"); event != "response.incomplete" {
		t.Fatalf("terminal event = %q, want response.incomplete", event)
	}
	if response["status"] != "incomplete" {
		t.Fatalf("status = %v, want incomplete", response["status"])
	}
	details, _ := response["incomplete_details"].(map[string]string)
	if details["reason"] != "max_output_tokens" {
		t.Fatalf("incomplete_details = %#v", response["incomplete_details"])
	}
}

func newStreamTestHandler(t *testing.T, upstream http.HandlerFunc) *Handler {
	//! newStreamTestHandler points the proxy at upstream with one account and no endpoint fallback.
	t.Helper()
	resetObservePersistenceForTest(t)
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{
		ID:          "only",
		Enabled:     true,
		AccessToken: "token-only",
		ProfileArn:  "arn:aws:codewhisperer:profile/only",
	}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	if err := config.UpdatePreferredEndpoint("kiro"); err != nil {
		t.Fatalf("set preferred endpoint: %v", err)
	}
	if err := config.UpdateEndpointFallback(false); err != nil {
		t.Fatalf("disable endpoint fallback: %v", err)
	}

	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)

	oldEndpoints := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{{URL: server.URL, Origin: "AI_EDITOR", Name: "test"}}
	t.Cleanup(func() { kiroEndpoints = oldEndpoints })

	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}})
	t.Cleanup(func() { kiroHttpStore.Store(oldClient) })

	oldWait := streamRetryWait
	streamRetryWait = func(context.Context, time.Duration) error { return nil }
	t.Cleanup(func() { streamRetryWait = oldWait })

	p := accountpool.GetPool()
	p.Reload()
	return &Handler{pool: p, promptCache: newPromptCacheTracker(defaultPromptCacheTTL)}
}

func testAccount(t *testing.T) *config.Account {
	t.Helper()
	accounts := config.GetAccounts()
	if len(accounts) == 0 {
		t.Fatalf("expected a configured account")
	}
	return &accounts[0]
}

func testKiroPayload() *KiroPayload {
	payload := &KiroPayload{}
	payload.ConversationState.CurrentMessage.UserInputMessage = KiroUserInputMessage{
		Content: "hello",
		ModelID: "claude-sonnet-4.5",
		Origin:  "AI_EDITOR",
	}
	return payload
}

func writeFrames(w http.ResponseWriter, frames ...[]byte) {
	w.WriteHeader(http.StatusOK)
	for _, frame := range frames {
		_, _ = w.Write(frame)
	}
}

func TestCallKiroAPIRetriesEmptyStreamBeforeOutput(t *testing.T) {
	var calls atomic.Int32
	newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			writeFrames(w)
			return
		}
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "second try"}),
			meteringFrame(t),
		)
	})

	var text string
	err := CallKiroAPIContext(context.Background(), testAccount(t), testKiroPayload(), &KiroStreamCallback{
		OnText: func(s string, _ bool) { text += s },
	})
	if err != nil {
		t.Fatalf("expected retry to recover, got %v", err)
	}
	if calls.Load() != 2 || text != "second try" {
		t.Fatalf("calls=%d text=%q, want 2 calls and only the second answer", calls.Load(), text)
	}
}

func TestCallKiroAPIStopsOnCanceledContext(t *testing.T) {
	var calls atomic.Int32
	newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) { calls.Add(1) })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := CallKiroAPIContext(ctx, testAccount(t), testKiroPayload(), &KiroStreamCallback{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("a canceled request must not reach upstream, got %d calls", calls.Load())
	}
}

func TestClaudeNonStreamRetriesTruncatedAnswerWithoutCoolingAccount(t *testing.T) {
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "cut off"}))
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("a truncated answer must fail, status=%d body=%s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 3 {
		t.Fatalf("expected three same-account attempts, got %d", calls.Load())
	}
	//! Three ordinary errors would cool the account down for a minute.
	if h.pool.GetNextForModelExcluding("claude-sonnet-4.5", map[string]bool{}) == nil {
		t.Fatalf("stream hiccups must not cool the account down")
	}
}

func TestClaudeNonStreamMapsUpstreamStopReason(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "long answer"}),
			awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "MAX_TOKENS"}),
		)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	var resp ClaudeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rec.Body.String())
	}
	if resp.StopReason != "max_tokens" {
		t.Fatalf("stop_reason = %q, want max_tokens", resp.StopReason)
	}
}

func TestClaudeStreamFlushesHeldTextBeforeError(t *testing.T) {
	const answer = "This answer is long enough to leave the stream buffer, and then it stops"
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": answer}))
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	h.handleClaudeStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	body := rec.Body.String()
	if calls.Load() != 1 {
		t.Fatalf("output already reached the client, so no retry is allowed; got %d calls", calls.Load())
	}
	if got := collectClaudeTextDeltas(t, body); got != answer {
		t.Fatalf("client text = %q, want full upstream text %q", got, answer)
	}
	if !strings.Contains(body, "event: error") || strings.Contains(body, "event: message_stop") {
		t.Fatalf("expected an error event and no message_stop, body=%s", body)
	}
}

func TestOpenAIStreamReportsTruncationAsError(t *testing.T) {
	const answer = "This answer is long enough to leave the stream buffer, and then it stops"
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": answer}))
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	h.handleOpenAIStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)

	body := rec.Body.String()
	if !strings.Contains(body, `"error":{`) {
		t.Fatalf("expected an error chunk, body=%s", body)
	}
	if strings.Contains(body, "[DONE]") {
		t.Fatalf("a truncated stream must not end with [DONE], body=%s", body)
	}
	if got := collectOpenAIContentDeltas(t, body); got != answer {
		t.Fatalf("client text = %q, want full upstream text %q", got, answer)
	}
}

func TestClaudeNonStreamClientDisconnectSkipsUpstream(t *testing.T) {
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) { calls.Add(1) })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil).WithContext(ctx)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	if calls.Load() != 0 {
		t.Fatalf("a gone client must not reach upstream, got %d calls", calls.Load())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("nothing should be written to a gone client, body=%s", rec.Body.String())
	}
	page := getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 10, Status: "failed"})
	if page.Total != 1 || page.Requests[0].Status != 499 {
		t.Fatalf("expected one 499 request row, got %#v", page.Requests)
	}
}

func collectClaudeTextDeltas(t *testing.T, body string) string {
	t.Helper()
	var text strings.Builder
	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		var event struct {
			Type  string `json:"type"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
		}
		if json.Unmarshal([]byte(data), &event) == nil && event.Type == "content_block_delta" && event.Delta.Type == "text_delta" {
			text.WriteString(event.Delta.Text)
		}
	}
	return text.String()
}

func collectOpenAIContentDeltas(t *testing.T, body string) string {
	t.Helper()
	var text strings.Builder
	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &chunk) == nil && len(chunk.Choices) > 0 {
			text.WriteString(chunk.Choices[0].Delta.Content)
		}
	}
	return text.String()
}
