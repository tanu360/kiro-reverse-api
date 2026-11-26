package proxy

import (
	"context"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// contextOverflowBody is Kiro's 400 for an input over the context window (recorded live).
const contextOverflowBody = `{"message":"Input is too long.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}`

// payloadWithToolHistory is a turn after a tool call, so a 400 would also retry it with the
// tool history narrated.
func payloadWithToolHistory() *KiroPayload {
	payload := testKiroPayload()
	payload.ConversationState.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{Content: "read a and b", ModelID: "claude-sonnet-4.5", Origin: "AI_EDITOR"}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{ToolUses: []KiroToolUse{{ToolUseID: "tooluse_0", Name: "read", Input: map[string]interface{}{"path": "a"}}}}},
		{UserInputMessage: &KiroUserInputMessage{ModelID: "claude-sonnet-4.5", Origin: "AI_EDITOR", UserInputMessageContext: &UserInputMessageContext{
			ToolResults: []KiroToolResult{{ToolUseID: "tooluse_0", Status: "success", Content: []KiroResultContent{{Text: "a"}}}},
		}}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{ToolUses: []KiroToolUse{{ToolUseID: "tooluse_1", Name: "read", Input: map[string]interface{}{"path": "b"}}}}},
	}
	payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext = &UserInputMessageContext{
		ToolResults: []KiroToolResult{{ToolUseID: "tooluse_1", Status: "success", Content: []KiroResultContent{{Text: "contents"}}}},
	}
	return payload
}

// An input over the context window is refused by the first endpoint; the proxy answers at
// once instead of asking the other endpoints, retrying with narrated tool history, or failing
// over to another account.
func TestContextOverflowEndsAtTheFirstEndpoint(t *testing.T) {
	h := newAttemptChainHandler(t, 1, http.NotFound)
	var mu sync.Mutex
	var hits []string
	threeKiroEndpoints(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits = append(hits, r.URL.Path)
		mu.Unlock()
		http.Error(w, contextOverflowBody, http.StatusBadRequest)
	})
	if !flattenStructuredToolHistory(payloadWithToolHistory()) {
		t.Fatal("the payload has no tool history to narrate")
	}

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), requestEndpointClaude)
	h.handleClaudeNonStream(rec, req, payloadWithToolHistory(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"message":"prompt is too long: `) {
		t.Fatalf("status %d body %s, want a 400 starting \"prompt is too long: \"", rec.Code, rec.Body.String())
	}
	if len(hits) != 1 || hits[0] != "/ide" {
		t.Fatalf("upstream calls = %v, want only the first endpoint", hits)
	}
}

// Other 4xx can be endpoint-specific, so they still move on to the next endpoint.
func TestOtherClientErrorStillTriesTheNextEndpoint(t *testing.T) {
	h := newAttemptChainHandler(t, 1, http.NotFound)
	var mu sync.Mutex
	var hits []string
	threeKiroEndpoints(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits = append(hits, r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/ide" {
			http.Error(w, `{"__type":"ValidationException","message":"Improperly formed request."}`, http.StatusBadRequest)
			return
		}
		writeFrames(w, answerFrame(t, "answered"), meteringFrame(t))
	})

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), requestEndpointClaude)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "answered") {
		t.Fatalf("status %d body %s, want the second endpoint's answer", rec.Code, rec.Body.String())
	}
	if len(hits) != 2 || hits[0] != "/ide" || hits[1] != "/cw" {
		t.Fatalf("upstream calls = %v, want /ide then /cw", hits)
	}
}

// CreateResponse's 413 for an over-long input is not retried without the replayed reasoning.
func TestContextOverflowIsNotRetriedWithoutReasoning(t *testing.T) {
	account := flagTestAccount(t, "overflow-reasoning")
	upstream := &chatAPITestUpstream{
		respAns: func(int) *http.Response {
			return httpAnswer(http.StatusRequestEntityTooLarge, "application/json", `{"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Input is too long."}}`)
		},
	}
	upstream.install(t)
	payload := testKiroPayload()
	payload.ProfileArn = testProfileArn
	payload.ConversationState.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{Content: "think", ModelID: "claude-sonnet-4.5", Origin: "AI_EDITOR"}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: "done", Reasoning: []KiroReasoningBlock{{Text: "hmm", Signature: "sig"}}}},
	}
	if err := config.UpdateChatAPI("responses"); err != nil {
		t.Fatalf("set mode: %v", err)
	}

	err := CallKiroAPIContext(context.Background(), account, payload, &KiroStreamCallback{})
	if !isContextOverflowError(err) {
		t.Fatalf("err = %v, want the context overflow", err)
	}
	if len(upstream.responses) != 1 || !strings.Contains(string(upstream.bodies[0]), `"type":"reasoning"`) {
		t.Fatalf("CreateResponse calls = %d, want 1 that replays the reasoning", len(upstream.responses))
	}
}
