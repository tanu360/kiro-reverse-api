package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestToolResultImagesAreAttached(t *testing.T) {
	const imgData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
	req := &ClaudeRequest{
		Model: "claude-opus-4.8",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "read this image"},
			{
				Role: "assistant",
				Content: []interface{}{
					map[string]interface{}{"type": "tool_use", "id": "tool_1", "name": "read", "input": map[string]interface{}{"path": "a.png"}},
				},
			},
			{
				Role: "user",
				Content: []interface{}{
					map[string]interface{}{
						"type":        "tool_result",
						"tool_use_id": "tool_1",
						"content": []interface{}{
							map[string]interface{}{
								"type": "image",
								"source": map[string]interface{}{
									"type":       "base64",
									"media_type": "image/png",
									"data":       imgData,
								},
							},
						},
					},
				},
			},
		},
	}

	payload := ClaudeToKiro(req, false)
	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if len(cur.Images) != 1 {
		t.Fatalf("expected tool_result image attached, got %d", len(cur.Images))
	}
	if cur.Images[0].Format != "png" || cur.Images[0].Source.Bytes != imgData {
		t.Fatalf("unexpected image payload: %+v", cur.Images[0])
	}
	if cur.UserInputMessageContext == nil || len(cur.UserInputMessageContext.ToolResults) != 1 {
		t.Fatalf("expected active tool result kept structured")
	}
	if cur.UserInputMessageContext.ToolResults[0].Content[0].Text != toolResultImagePlaceholder {
		t.Fatalf("expected image placeholder in tool result, got %q", cur.UserInputMessageContext.ToolResults[0].Content[0].Text)
	}
}

func TestOpenAIToolResultImageCarriedWhenFollowedByUser(t *testing.T) {
	const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
	req := &OpenAIRequest{
		Model: "claude-sonnet-4.5",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "look"},
			{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_img", "read", `{"path":"a.png"}`)}},
			{Role: "tool", ToolCallID: "call_img", Content: []interface{}{map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": dataURL}}}},
			{Role: "user", Content: "what do you see?"},
		},
	}

	payload := OpenAIToKiro(req, false)
	historyImages := 0
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage != nil {
			historyImages += len(h.UserInputMessage.Images)
		}
	}
	if historyImages != 1 {
		t.Fatalf("expected tool image on flushed tool-result history, got %d", historyImages)
	}
	if len(payload.ConversationState.CurrentMessage.UserInputMessage.Images) != 0 {
		t.Fatalf("tool image leaked into later current user message")
	}
}

func TestClaudeToolResultPreservesMixedTextAndImage(t *testing.T) {
	const imgData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
	req := &ClaudeRequest{
		Model: "claude-opus-4.8",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "inspect"},
			{
				Role: "assistant",
				Content: []interface{}{
					map[string]interface{}{"type": "tool_use", "id": "tool_mixed", "name": "read", "input": map[string]interface{}{"path": "a.png"}},
				},
			},
			{
				Role: "user",
				Content: []interface{}{
					map[string]interface{}{
						"type":        "tool_result",
						"tool_use_id": "tool_mixed",
						"content": []interface{}{
							map[string]interface{}{"type": "text", "text": "OCR: hello"},
							map[string]interface{}{
								"type": "image",
								"source": map[string]interface{}{
									"type":       "base64",
									"media_type": "image/png",
									"data":       imgData,
								},
							},
						},
					},
				},
			},
		},
	}

	payload := ClaudeToKiro(req, false)
	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if len(cur.Images) != 1 {
		t.Fatalf("expected mixed tool_result image attached, got %d", len(cur.Images))
	}
	ctx := cur.UserInputMessageContext
	if ctx == nil || len(ctx.ToolResults) != 1 {
		t.Fatalf("expected mixed tool_result kept structured, got %#v", ctx)
	}
	if got := ctx.ToolResults[0].Content[0].Text; got != "OCR: hello" {
		t.Fatalf("expected text part preserved exactly once, got %q", got)
	}
}

func TestOpenAIToKiroDoesNotDuplicateToolResultText(t *testing.T) {
	req := &OpenAIRequest{
		Model: "claude-opus-4.8",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "run it"},
			{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_1", "exec_command", `{"cmd":"ls"}`)}},
			{Role: "tool", ToolCallID: "call_1", Content: "UNIQUE_OUTPUT_MARKER_12345"},
			{Role: "user", Content: "now summarize"},
		},
	}

	payload := OpenAIToKiro(req, false)
	count := 0
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage != nil {
			count += strings.Count(h.UserInputMessage.Content, "UNIQUE_OUTPUT_MARKER_12345")
		}
		if h.AssistantResponseMessage != nil {
			count += strings.Count(h.AssistantResponseMessage.Content, "UNIQUE_OUTPUT_MARKER_12345")
		}
	}
	if count != 1 {
		t.Fatalf("expected tool result output exactly once in history, got %d", count)
	}
}

func TestOpenAIHistoryRemovesFakeToolCallNarration(t *testing.T) {
	req := &OpenAIRequest{
		Model: "claude-opus-4.8",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "run it"},
			{Role: "assistant", Content: "[Called tool exec_command]"},
			{Role: "user", Content: "continue"},
		},
	}

	payload := OpenAIToKiro(req, false)
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil && strings.Contains(h.AssistantResponseMessage.Content, "[Called tool") {
			t.Fatalf("fake tool-call narration leaked into history: %#v", h.AssistantResponseMessage)
		}
	}
}

func TestOpenAIHistoryCollapsesRepeatedIdenticalToolResults(t *testing.T) {
	req := &OpenAIRequest{
		Model: "claude-opus-4.8",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "run it"},
			{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_1", "exec_command", `{"cmd":"ls"}`)}},
			{Role: "tool", ToolCallID: "call_1", Content: "DUPLICATE_TOOL_OUTPUT"},
			{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_2", "exec_command", `{"cmd":"ls"}`)}},
			{Role: "tool", ToolCallID: "call_2", Content: "DUPLICATE_TOOL_OUTPUT"},
			{Role: "user", Content: "summarize"},
		},
	}

	payload := OpenAIToKiro(req, false)
	count := 0
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage != nil {
			count += strings.Count(h.UserInputMessage.Content, "DUPLICATE_TOOL_OUTPUT")
		}
		if h.AssistantResponseMessage != nil {
			count += strings.Count(h.AssistantResponseMessage.Content, "DUPLICATE_TOOL_OUTPUT")
		}
	}
	if count != 1 {
		t.Fatalf("expected duplicate tool output collapsed to one history copy, got %d", count)
	}
}

func TestOpenAIHistoryDropsHollowAssistantTurns(t *testing.T) {
	req := &OpenAIRequest{
		Model: "claude-opus-4.8",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "first"},
			{Role: "assistant", Content: "."},
			{Role: "user", Content: "next"},
		},
	}

	payload := OpenAIToKiro(req, false)
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil && strings.TrimSpace(h.AssistantResponseMessage.Content) == "." {
			t.Fatalf("hollow assistant turn leaked into history")
		}
	}
}

func TestResponsesParallelFunctionCallsMerge(t *testing.T) {
	raw := json.RawMessage(`[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"run two commands"}]},
		{"type":"function_call","call_id":"call_a","name":"exec_command","arguments":"{\"cmd\":\"ls\"}"},
		{"type":"function_call","call_id":"call_b","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"},
		{"type":"function_call_output","call_id":"call_a","output":"file1"},
		{"type":"function_call_output","call_id":"call_b","output":"/home"}
	]`)

	msgs, err := responsesInputToMessages(raw)
	if err != nil {
		t.Fatalf("responsesInputToMessages: %v", err)
	}
	assistantWithCalls := 0
	toolCallCount := 0
	for _, msg := range msgs {
		if msg.Role == "assistant" && len(msg.ToolCalls) > 0 {
			assistantWithCalls++
			toolCallCount = len(msg.ToolCalls)
		}
	}
	if assistantWithCalls != 1 || toolCallCount != 2 {
		t.Fatalf("expected one assistant message with two tool calls, got messages=%d calls=%d", assistantWithCalls, toolCallCount)
	}
}

func TestGetContextWindowSizeClassifiesLargeContextModels(t *testing.T) {
	cases := map[string]int{
		"claude-opus-4.8":          1_000_000,
		"claude-opus-4-8":          1_000_000,
		"claude-sonnet-4.6":        1_000_000,
		"claude-opus-4.8-thinking": 1_000_000,
		"claude-sonnet-4.5":        200_000,
		"claude-haiku-4.5":         200_000,
		"unknown-model":            200_000,
	}
	for model, want := range cases {
		if got := getContextWindowSize(model); got != want {
			t.Fatalf("getContextWindowSize(%q) = %d, want %d", model, got, want)
		}
	}
}

func testToolCall(id, name, args string) ToolCall {
	tc := ToolCall{ID: id, Type: "function"}
	tc.Function.Name = name
	tc.Function.Arguments = args
	return tc
}
