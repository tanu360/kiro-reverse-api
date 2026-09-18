package proxy

import (
	"context"
	"encoding/json"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestReviewOrphanToolResultRetainsText(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", Messages: []ClaudeMessage{{Role: "user", Content: []interface{}{
		map[string]interface{}{"type": "text", "text": "Continue from the compacted summary."},
		map[string]interface{}{"type": "tool_result", "tool_use_id": "old-call", "content": "IMPORTANT_TOOL_RESULT_123"},
	}}}}
	raw, _ := json.Marshal(ClaudeToKiro(req, false))
	if !strings.Contains(string(raw), "IMPORTANT_TOOL_RESULT_123") {
		t.Fatalf("orphan tool result lost entirely: %s", raw)
	}
}

func TestNativeSearchThinkingSSEAndDisplayOptions(t *testing.T) {
	for _, tc := range []struct {
		name, format, display, want string
		stream                      bool
	}{
		{"stream", "thinking", "summarized", `"thinking_delta"`, true},
		{"omitted", "thinking", "omitted", `"thinking":""`, false},
		{"omitted-stream", "thinking", "omitted", `"thinking":""`, true},
		{"tagged", "think", "", `think`, false},
		{"plain", "reasoning_content", "", `visible-reasoninganswer`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
				writeFrames(w, awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "visible-reasoning"}), awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answer"}), meteringFrame(t))
			})
			if err := config.UpdateThinkingConfig("-thinking", "reasoning_content", tc.format); err != nil {
				t.Fatal(err)
			}
			body := map[string]interface{}{"model": "claude-sonnet-4.5", "max_tokens": 2048, "stream": tc.stream, "thinking": map[string]interface{}{"type": "enabled", "budget_tokens": 1024, "display": tc.display}, "tools": []interface{}{map[string]interface{}{"type": "web_search_20250305", "name": "web_search"}}, "messages": []interface{}{map[string]interface{}{"role": "user", "content": "hello"}}}
			raw, _ := json.Marshal(body)
			rec := postClaudeMessages(t, h, string(raw))
			if rec.Code != 200 || !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("status=%d response=%s", rec.Code, rec.Body.String())
			}
			if tc.display == "omitted" && strings.Contains(rec.Body.String(), "visible-reasoning") {
				t.Fatal("omitted reasoning leaked")
			}
		})
	}
}

func TestStopReasonRetryAcrossOpenAIEndpoints(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, stream := range []bool{false, true} {
			t.Run(path+map[bool]string{false: "-json", true: "-sse"}[stream], func(t *testing.T) {
				var calls atomic.Int32
				h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
					if calls.Add(1) == 1 {
						writeFrames(w, awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "max_tokens"}))
						return
					}
					writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "complete"}), meteringFrame(t))
				})
				body := map[string]interface{}{"model": "claude-sonnet-4.5", "stream": stream, "messages": []interface{}{map[string]interface{}{"role": "user", "content": "hello"}}, "input": "hello", "store": false}
				raw, _ := json.Marshal(body)
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw))))
				want := `"finish_reason":"stop"`
				if path == "/v1/responses" {
					want = `"status":"completed"`
				}
				if rec.Code != 200 || !strings.Contains(rec.Body.String(), want) || strings.Contains(rec.Body.String(), `"max_output_tokens"`) {
					t.Fatalf("status=%d response=%s", rec.Code, rec.Body.String())
				}
			})
		}
	}
}

func TestMCPEmptyArrayIsValidButNullIsNot(t *testing.T) {
	for _, payload := range []string{`[]`, `{"results":[]}`} {
		results, ok, err := decodeWebSearchResults([]byte(payload))
		if !ok || err != nil || len(results) != 0 {
			t.Fatalf("valid empty results rejected: %s", payload)
		}
	}
	for _, payload := range []string{`null`, `{"results":null}`, `{}`} {
		_, ok, err := decodeWebSearchResults([]byte(payload))
		if ok && err == nil {
			t.Fatalf("invalid results accepted: %s", payload)
		}
	}
}

func TestOpenAIOrphanToolResultWithImageRetainsText(t *testing.T) {
	const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
	req := &OpenAIRequest{Model: "claude-sonnet-4.5", Messages: []OpenAIMessage{{Role: "tool", ToolCallID: "orphan", Content: []interface{}{map[string]interface{}{"type": "text", "text": "tool-evidence"}, map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": dataURL}}}}}}
	payload := OpenAIToKiro(req, false)
	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if !strings.Contains(cur.Content, "tool-evidence") || len(cur.Images) != 1 {
		t.Fatalf("lost text or image: %+v", cur)
	}
}

func TestReviewMCPRejectsNullResults(t *testing.T) {
	_, err := parseMCPWebSearchResponse([]byte(`{"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"null"}]}}`))
	if err == nil {
		t.Fatal("malformed null search payload accepted as successful empty result")
	}
}

func TestReviewSearchResolvesMissingProfile(t *testing.T) {
	newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected model request") })
	account := testAccount(t)
	account.ProfileArn = ""
	old := kiroRestHttpStore.Load()
	t.Cleanup(func() { kiroRestHttpStore.Store(old) })
	var profileCalls int
	var host, arn string
	kiroRestHttpStore.Store(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := mcpOneResult
		if strings.Contains(r.URL.Path, "ListAvailableProfiles") {
			profileCalls++
			body = `{"profiles":[{"arn":"arn:aws:codewhisperer:eu-central-1:123456789012:profile/example"}]}`
		} else {
			host = r.URL.Host
			arn = r.Header.Get("x-amzn-kiro-profile-arn")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})})
	_, err := performKiroWebSearch(context.Background(), account, "go")
	if err != nil {
		t.Fatal(err)
	}
	if profileCalls == 0 || host != "q.eu-central-1.amazonaws.com" || arn == "" {
		t.Fatalf("profileCalls=%d MCP host=%s profile header=%q", profileCalls, host, arn)
	}
}

func TestReviewStaleStatusDoesNotOverwriteRotatedToken(t *testing.T) {
	newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected network request") })
	stale := *testAccount(t)
	if err := config.UpdateAccountToken(stale.ID, "new-access", "new-refresh", 123456); err != nil {
		t.Fatal(err)
	}
	stale.Nickname = "renamed"
	if err := config.UpdateAccount(stale.ID, stale); err != nil {
		t.Fatal(err)
	}
	got := testAccount(t)
	if got.AccessToken != "new-access" || got.RefreshToken != "new-refresh" {
		t.Fatalf("stale status write restored old credentials: access=%q refresh=%q", got.AccessToken, got.RefreshToken)
	}
}

func TestReviewRetryDoesNotLeakStopReason(t *testing.T) {
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			writeFrames(w, awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "max_tokens"}))
			return
		}
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "complete successful second attempt"}), meteringFrame(t))
	})
	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}`))
	if msg["stop_reason"] != "end_turn" {
		t.Fatalf("successful retry inherits previous attempt stop_reason=%v; calls=%d", msg["stop_reason"], calls.Load())
	}
}

func TestReviewNativeSearchPreservesThinking(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		writeFrames(w, awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "reasoning visible in ordinary Claude path"}), awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answer without needing search"}), meteringFrame(t))
	})
	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":2048,"thinking":{"type":"enabled","budget_tokens":1024},"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"hello"}]}`))
	if !strings.Contains(strings.Join(contentTypes(msg), ","), "thinking") {
		t.Fatalf("native search drops thinking even without any searches; types=%v", contentTypes(msg))
	}
}

func TestReviewNativeSearchCountsAllRoundInputs(t *testing.T) {
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		usage := awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn", "inputTokens": 100, "outputTokens": 10})
		if calls.Add(1) == 1 {
			writeFrames(w, webSearchToolUseFrame(t, "search1", "go"), usage)
			return
		}
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answer"}), usage)
	})
	stubMCPWebSearch(t, http.StatusOK, mcpOneResult)
	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"look up go"}]}`))
	usage := msg["usage"].(map[string]interface{})
	if usage["input_tokens"] != float64(200) {
		t.Fatalf("two 100-token model calls report input_tokens=%v; calls=%d", usage["input_tokens"], calls.Load())
	}
}
