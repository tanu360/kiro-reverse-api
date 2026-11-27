package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"kiro-proxy/config"
)

// Claude 5 models refuse a history whose assistant text holds earlier reasoning (live: Opus
// answered stop_reason "refusal" to "<think>…</think>391" replayed as content). Every API's
// history translator keeps reasoning out of assistant text.

func TestStripReplayedInlineThinking(t *testing.T) {
	cases := map[string]string{
		"<think>17*23 is 391</think>391":                   "391",
		"<thinking>17*23 is 391</thinking>\n\n391":         "391",
		"  \n<think>a</think><thinking>b</thinking>x":      "x",
		"<think>cut off mid-thought":                       "",
		"391":                                              "391",
		"Use <thinking> tags like <thinking>x</thinking>.": "Use <thinking> tags like <thinking>x</thinking>.",
		"": "",
	}
	for in, want := range cases {
		if got := stripReplayedInlineThinking(in); got != want {
			t.Errorf("stripReplayedInlineThinking(%q) = %q, want %q", in, got, want)
		}
	}
}

func openAIHistoryAssistant(t *testing.T, content interface{}, toolCalls []ToolCall) KiroAssistantResponseMessage {
	t.Helper()
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: []OpenAIMessage{
		{Role: "user", Content: "what is 17 * 23?"},
		{Role: "assistant", Content: content, ToolCalls: toolCalls},
		{Role: "user", Content: "add 10"},
	}}, true)
	for _, entry := range payload.ConversationState.History {
		if a := entry.AssistantResponseMessage; a != nil && a.Content != "I will follow these instructions." {
			return *a
		}
	}
	t.Fatal("no assistant message in history")
	return KiroAssistantResponseMessage{}
}

func TestOpenAIAssistantHistoryKeepsReasoningOutOfText(t *testing.T) {
	for name, content := range map[string]interface{}{
		"think tags (openaiThinkingFormat think)": "<think>17*23: 340+51</think>391",
		"thinking tags":                 "<thinking>17*23: 340+51</thinking>\n391",
		"reasoning part":                []interface{}{map[string]interface{}{"type": "reasoning", "text": "17*23: 340+51"}, map[string]interface{}{"type": "text", "text": "391"}},
		"summary_text part":             []interface{}{map[string]interface{}{"type": "summary_text", "text": "17*23"}, map[string]interface{}{"type": "output_text", "text": "391"}},
		"thinking part beside text":     []interface{}{map[string]interface{}{"type": "thinking", "thinking": "17*23", "signature": "sig"}, map[string]interface{}{"type": "text", "text": "391"}},
		"think tags inside a text part": []interface{}{map[string]interface{}{"type": "text", "text": "<think>17*23</think>391"}},
	} {
		if got := openAIHistoryAssistant(t, content, nil).Content; got != "391" {
			t.Errorf("%s: assistant history content = %q, want %q", name, got, "391")
		}
	}
}

// An assistant turn with only reasoning (beside its tool calls) has no text: its parts must
// not reach Kiro as JSON.
func TestOpenAIAssistantReasoningOnlyTurnHasNoText(t *testing.T) {
	got := extractOpenAIAssistantText([]interface{}{
		map[string]interface{}{"type": "thinking", "thinking": "I should read a", "signature": "sig"},
		map[string]interface{}{"type": "redacted_thinking", "data": "abc"},
	})
	if got != "" {
		t.Fatalf("assistant text = %q, want empty", got)
	}
}

func TestClaudeAssistantHistoryKeepsReasoningOutOfText(t *testing.T) {
	text, _ := extractClaudeAssistantContent([]interface{}{
		map[string]interface{}{"type": "text", "text": "<thinking>17*23: 340+51</thinking>\n391"},
	})
	if text != "391" {
		t.Fatalf("text block content = %q, want %q", text, "391")
	}
	if s, _ := extractClaudeAssistantContent("<think>17*23</think>391"); s != "391" {
		t.Fatalf("string content = %q, want %q", s, "391")
	}
	quoted := "Wrap it like <thinking>x</thinking>."
	if s, _ := extractClaudeAssistantContent(quoted); s != quoted {
		t.Fatalf("a tag the answer quotes was changed: %q", s)
	}
}

func TestResponsesReasoningItemNeverBecomesAMessage(t *testing.T) {
	for _, item := range []map[string]interface{}{
		{"type": "reasoning", "summary": []interface{}{map[string]interface{}{"type": "summary_text", "text": "17*23"}}},
		{"type": "reasoning", "role": "assistant", "content": []interface{}{map[string]interface{}{"type": "reasoning_text", "text": "17*23"}}},
	} {
		messages, err := responseInputItemToMessages(item, "input[1]")
		if err != nil || len(messages) != 0 {
			t.Fatalf("reasoning item %v became %+v (err %v), want nothing", item, messages, err)
		}
	}
}

// The hosted web search's follow-up round replays the answer, not the inline thinking Kiro's
// older API streams in the same text.
func TestHostedSearchFollowupReplaysOnlyTheAnswer(t *testing.T) {
	answer, thinking := splitInlineThinking("<thinking>I should search</thinking>Let me look that up.")
	payload := buildWebSearchFollowupPayload(testKiroPayload(), []KiroToolUse{{ToolUseID: "s1", Name: "web_search", Input: map[string]interface{}{"query": "q"}}}, nil, answer)
	if thinking != "I should search" {
		t.Fatalf("thinking = %q", thinking)
	}
	for _, entry := range payload.ConversationState.History {
		if a := entry.AssistantResponseMessage; a != nil && strings.Contains(a.Content, "thinking") {
			t.Fatalf("follow-up history holds reasoning as text: %q", a.Content)
		}
	}
}

func TestStructuredRetryNeverFollowsARefusal(t *testing.T) {
	payload := testKiroPayload()
	for reason, want := range map[string]bool{"refusal": false, "CONTENT_FILTERED": false, "guardrail_intervened": false, "END_TURN": true} {
		a := &structuredAttempt{stopReason: reason}
		if got := a.canRetry(payload); got != want {
			t.Errorf("canRetry after %q = %t, want %t", reason, got, want)
		}
	}
}

func TestToolHistoryFallbackLeavesThePayloadAndSkipsUnrelated400s(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	for name, first := range map[string]error{
		"model the account cannot use": &upstreamClientError{status: http.StatusBadRequest, message: `{"reason":"INVALID_MODEL_ID"}`},
		"replayed reasoning rejected":  &upstreamClientError{status: http.StatusBadRequest, message: `{"reason":"THINKING_SIGNATURE_INVALID"}`},
	} {
		payload := payloadWithToolHistory()
		calls := 0
		err := callWithToolHistoryFallback(payload, func(*KiroPayload) error { calls++; return first })
		if calls != 1 || !errors.Is(err, first) {
			t.Errorf("%s: %d calls, err %v; want the first answer and no narrated retry", name, calls, err)
		}
	}

	payload := payloadWithToolHistory()
	before, _ := json.Marshal(payload.ConversationState.History)
	var seen []*KiroPayload
	_ = callWithToolHistoryFallback(payload, func(p *KiroPayload) error {
		seen = append(seen, p)
		if len(seen) == 1 {
			return &upstreamClientError{status: http.StatusBadRequest, message: "Improperly formed request."}
		}
		return errors.New("account A failed")
	})
	if len(seen) != 2 || seen[1] == payload {
		t.Fatalf("narrated retry got %d payloads (same pointer %t), want a copy", len(seen), len(seen) == 2 && seen[1] == payload)
	}
	//! Account failover still needs the structured history after a narrated retry failed.
	if after, _ := json.Marshal(payload.ConversationState.History); string(after) != string(before) {
		t.Fatalf("the narrated retry changed the caller's payload:\n%s\nwant\n%s", after, before)
	}
}

func TestResponsesRefusalPartEndsWithRefusal(t *testing.T) {
	stream := `data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","status":"in_progress","output":[]}}

data: {"type":"response.refusal.delta","sequence_number":1,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"I can't help with that."}

data: {"type":"response.refusal.done","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"refusal":"I can't help with that."}

data: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_1","status":"completed","output":[],"usage":{}}}

`
	r, _, err := runResponsesStream(t, stream)
	if err != nil {
		t.Fatal(err)
	}
	if mapClaudeStopReason(r.stopReason, 0) != "refusal" || r.text != "I can't help with that." {
		t.Fatalf("stop %q text %q, want a refusal with its words", r.stopReason, r.text)
	}
}

func TestEmptyRefusalHasNoFabricatedAnswer(t *testing.T) {
	response := map[string]interface{}{"output": []map[string]interface{}{
		{"type": "reasoning"},
		{"type": "message", "status": "completed", "content": []interface{}{map[string]interface{}{"type": "output_text", "text": ""}}},
	}}
	stored := []OpenAIMessage{{Role: "user", Content: "hi"}, {Role: "assistant", Content: ""}}
	stored = withoutEmptyRefusalAnswer(response, stored, "CONTENT_FILTERED", "", nil)
	output := response["output"].([]map[string]interface{})
	if len(output) != 1 || output[0]["type"] != "reasoning" {
		t.Fatalf("output = %+v, want only the reasoning item", output)
	}
	if len(stored) != 1 || stored[0].Role != "user" {
		t.Fatalf("stored = %+v, want no empty assistant turn", stored)
	}
	kept := withoutEmptyRefusalAnswer(map[string]interface{}{}, []OpenAIMessage{{Role: "assistant", Content: "No."}}, "refusal", "No.", nil)
	if len(kept) != 1 {
		t.Fatal("a refusal in words lost its stored answer")
	}
}

func TestRefusalIsNamedInTheRequestLog(t *testing.T) {
	s := newObserveStoreForTest(t)
	recordObservedSuccess(context.Background(), nil, nil, "claude-opus-5.5", 13787, 0, 0, cacheTokenCounts{}, "refusal")
	recordObservedSuccess(context.Background(), nil, nil, "claude-opus-5.5", 10, 2, 0, cacheTokenCounts{}, "END_TURN")
	reqs := s.RecentRequests(2)
	if len(reqs) != 2 {
		t.Fatalf("requests = %+v", reqs)
	}
	byTokens := map[int]string{}
	for _, r := range reqs {
		if !r.Success || r.Status != 200 {
			t.Fatalf("a refusal is a successful call (the account is fine): %+v", r)
		}
		byTokens[r.InTokens] = r.Message
	}
	if byTokens[13787] != refusedRequestMessage || byTokens[10] != "" {
		t.Fatalf("messages = %+v, want the refusal named and the answer plain", byTokens)
	}
}

func TestSplitSignedThinkingKeepsEachSignature(t *testing.T) {
	merged := []ClaudeContentBlock{{Type: "thinking", Thinking: "first second", Signature: "sig-2"}, {Type: "text", Text: "391"}}
	signed := []ClaudeContentBlock{{Type: "thinking", Thinking: "first ", Signature: "sig-1"}, {Type: "thinking", Thinking: "second", Signature: "sig-2"}}
	got := splitSignedThinking(merged, signed)
	if len(got) != 3 || got[0].Signature != "sig-1" || got[1].Signature != "sig-2" || got[1].Thinking != "second" || got[2].Text != "391" {
		t.Fatalf("blocks = %+v", got)
	}
	if one := splitSignedThinking(merged, signed[:1]); len(one) != 2 {
		t.Fatal("a single signed block was split")
	}
	other := []ClaudeContentBlock{{Type: "thinking", Thinking: "different", Signature: "sig-2"}}
	if kept := splitSignedThinking(other, signed); len(kept) != 1 || kept[0].Thinking != "different" {
		t.Fatal("blocks that are not the merged reasoning were split")
	}
}

func TestStreamValidationExceptionIsAClientError(t *testing.T) {
	err := upstreamEventStreamError("exception", map[string]string{":exception-type": "ValidationException"}, map[string]interface{}{"message": "Input is too long."})
	var client *upstreamClientError
	if !errors.As(err, &client) || client.status != http.StatusBadRequest {
		t.Fatalf("err = %v, want a 400 client error", err)
	}
	err = upstreamEventStreamError("exception", map[string]string{":exception-type": "ModelStreamErrorException"}, map[string]interface{}{"message": "try again"})
	if !errors.Is(err, errKiroEventStreamUpstream) {
		t.Fatalf("err = %v, want a retryable stream error", err)
	}
}

func TestOpenAISystemPromptGoesThroughThePromptFilters(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	rules := []config.PromptFilterRule{{ID: "r1", Name: "drop telemetry", Type: "lines-containing", Match: "TELEMETRY", Enabled: true}}
	if err := config.UpdatePromptFilterConfig(false, false, false, rules); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = config.UpdatePromptFilterConfig(false, false, false, nil) })
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: []OpenAIMessage{
		{Role: "system", Content: "Be brief.\nTELEMETRY id=42"},
		{Role: "user", Content: "hi"},
	}}, false)
	system := payload.ConversationState.History[0].UserInputMessage.Content
	if strings.Contains(system, "TELEMETRY") || !strings.Contains(system, "Be brief.") {
		t.Fatalf("system prompt = %q, want the rule applied", system)
	}
}

// Sonnet on CreateResponse answers REQUEST_BODY_INVALID to a message with several reasoning
// items; the retry drops those messages' reasoning only, on a copy.
func TestMultiBlockReasoningFallbackKeepsSingleBlocks(t *testing.T) {
	payload := reasoningOnlyPayload(KiroReasoningBlock{Text: "a", Signature: "s1"}, KiroReasoningBlock{Text: "b", Signature: "s2"})
	payload.ConversationState.History = append(payload.ConversationState.History,
		KiroHistoryMessage{UserInputMessage: &KiroUserInputMessage{Content: "again", ModelID: "claude-sonnet-5", Origin: "AI_EDITOR"}},
		KiroHistoryMessage{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: "ok", Reasoning: []KiroReasoningBlock{{Text: "c", Signature: "s3"}}}},
	)
	if !hasMultiBlockReasoning(payload) {
		t.Fatal("a message with two blocks was not seen")
	}
	trimmed := withoutMultiBlockReasoning(payload)
	if hasMultiBlockReasoning(trimmed) {
		t.Fatal("the retry still replays a message with two blocks")
	}
	if got := trimmed.ConversationState.History[3].AssistantResponseMessage.Reasoning; len(got) != 1 {
		t.Fatalf("a single block was dropped: %+v", got)
	}
	if len(payload.ConversationState.History[1].AssistantResponseMessage.Reasoning) != 2 {
		t.Fatal("the retry changed the caller's payload")
	}
	body := &upstreamClientError{status: http.StatusBadRequest, message: `HTTP 400 from Kiro Responses: {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`}
	if !isRequestBodyRejection(body) || isRequestBodyRejection(&upstreamClientError{status: http.StatusBadRequest, message: "INVALID_MODEL_ID"}) {
		t.Fatal("REQUEST_BODY_INVALID is not told apart")
	}
}
