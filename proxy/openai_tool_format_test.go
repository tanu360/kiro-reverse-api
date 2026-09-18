package proxy

import (
	"encoding/json"
	"testing"
)

func mustOpenAITool(t *testing.T, raw string) OpenAITool {
	t.Helper()
	var tool OpenAITool
	if err := json.Unmarshal([]byte(raw), &tool); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	return tool
}

func TestOpenAIToolAcceptsResponsesFlatFormat(t *testing.T) {
	//! Some chat-completions clients send the Responses tool shape; the name used to come out empty and the tool was dropped.
	tool := mustOpenAITool(t, `{"type":"function","name":"exec_command","description":"Run a shell command","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}`)
	if tool.Type != "function" || tool.Function.Name != "exec_command" || tool.Function.Description != "Run a shell command" {
		t.Fatalf("flat tool parsed as %#v", tool)
	}
	if tool.Function.Parameters == nil {
		t.Fatalf("flat tool lost its parameters")
	}
}

func TestOpenAIToolNestedFormatWins(t *testing.T) {
	tool := mustOpenAITool(t, `{"type":"function","name":"flat_name","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object"}}}`)
	if tool.Function.Name != "get_weather" || tool.Function.Description != "Get weather" {
		t.Fatalf("nested tool parsed as %#v", tool)
	}
}

func TestOpenAIToKiroKeepsFlatFormatTools(t *testing.T) {
	var req OpenAIRequest
	if err := json.Unmarshal([]byte(`{
		"model":"claude-sonnet-4.5",
		"messages":[{"role":"user","content":"hi"}],
		"tools":[
			{"type":"function","name":"execCommand","parameters":{"type":"object"}},
			{"type":"function","function":{"name":"updatePlan","parameters":{"type":"object"}}}
		]
	}`), &req); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}

	payload := OpenAIToKiro(&req, false)
	ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
	if ctx == nil || len(ctx.Tools) != 2 {
		t.Fatalf("expected both tools sent to Kiro, got %#v", ctx)
	}
	for i, want := range []string{"execCommand", "updatePlan"} {
		if got := ctx.Tools[i].ToolSpecification.Name; got != want {
			t.Fatalf("tool %d name = %q, want %q", i, got, want)
		}
	}
}
