package proxy

import (
	"context"
	"strings"
	"testing"
)

// Live 2026-11-20: tool_choice.disable_parallel_tool_use was ignored, and "weather in Rome
// and Paris?" came back with two tool calls.

func claudeParallelTestPayload(choice interface{}) *KiroPayload {
	return ClaudeToKiro(&ClaudeRequest{
		Model:      "claude-sonnet-4.5",
		MaxTokens:  100,
		Messages:   []ClaudeMessage{{Role: "user", Content: "Weather in Rome and Paris?"}},
		Tools:      []ClaudeTool{{Name: "get_weather", InputSchema: map[string]interface{}{"type": "object"}}},
		ToolChoice: choice,
	}, false)
}

func TestClaudeDisableParallelToolUseAllowsOneCall(t *testing.T) {
	for _, tc := range []struct {
		name   string
		choice interface{}
		want   bool
	}{
		{"absent", nil, false},
		{"auto", map[string]interface{}{"type": "auto"}, false},
		{"auto with parallel off", map[string]interface{}{"type": "auto", "disable_parallel_tool_use": true}, true},
		{"any with parallel off", map[string]interface{}{"type": "any", "disable_parallel_tool_use": true}, true},
		{"tool with parallel on", map[string]interface{}{"type": "tool", "name": "get_weather", "disable_parallel_tool_use": false}, false},
		{"none with parallel off", map[string]interface{}{"type": "none", "disable_parallel_tool_use": true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := claudeParallelTestPayload(tc.choice)
			if payload.SingleToolCall != tc.want {
				t.Fatalf("SingleToolCall = %t, want %t", payload.SingleToolCall, tc.want)
			}
			content := payload.ConversationState.CurrentMessage.UserInputMessage.Content
			if has := strings.Contains(content, singleToolCallDirective); has != tc.want {
				t.Fatalf("directive present = %t, want %t, in %q", has, tc.want, content)
			}
		})
	}
}

func TestSingleToolCallPassesOnlyTheFirstCall(t *testing.T) {
	script := &scriptedKiro{hops: []scriptedHop{
		{text: []string{"Checking both."}, tools: []KiroToolUse{
			{ToolUseID: "t1", Name: "get_weather", Input: map[string]interface{}{"city": "Rome"}},
			{ToolUseID: "t2", Name: "get_weather", Input: map[string]interface{}{"city": "Paris"}},
		}, stop: "tool_use"},
	}}
	payload := claudeParallelTestPayload(map[string]interface{}{"type": "auto", "disable_parallel_tool_use": true})
	rec := &continueRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, payload, rec.callback(), script.call); err != nil {
		t.Fatal(err)
	}
	if len(rec.tools) != 1 || rec.tools[0].ToolUseID != "t1" || rec.text != "Checking both." {
		t.Fatalf("tools %v text %q, want only the first call", rec.tools, rec.text)
	}
}

func TestParallelToolCallsStayOnByDefault(t *testing.T) {
	script := &scriptedKiro{hops: []scriptedHop{
		{tools: []KiroToolUse{{ToolUseID: "t1", Name: "get_weather"}, {ToolUseID: "t2", Name: "get_weather"}}, stop: "tool_use"},
	}}
	rec := &continueRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, claudeParallelTestPayload(nil), rec.callback(), script.call); err != nil {
		t.Fatal(err)
	}
	if len(rec.tools) != 2 {
		t.Fatalf("tools %v, want both calls", rec.tools)
	}
}
