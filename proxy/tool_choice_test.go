package proxy

import (
	"strings"
	"testing"
)

func openAIChoiceTestTools(names ...string) []OpenAITool {
	tools := make([]OpenAITool, 0, len(names))
	for _, name := range names {
		var tool OpenAITool
		tool.Type = "function"
		tool.Function.Name = name
		tool.Function.Parameters = map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
		tools = append(tools, tool)
	}
	return tools
}

// Live on 8080 before this fix, Chat Completions ignored tool_choice entirely:
// "none" still produced a get_weather call, and "required" or a named function
// produced plain text with no call.
func TestOpenAIToKiroEnforcesToolChoice(t *testing.T) {
	//! wantTools are the Kiro-side names; convertOpenAITools camel-cases snake_case.
	for _, tc := range []struct {
		name      string
		choice    interface{}
		wantTools []string
		directive string
	}{
		{name: "absent", choice: nil, wantTools: []string{"getWeather", "getTime"}},
		{name: "auto", choice: "auto", wantTools: []string{"getWeather", "getTime"}},
		{name: "none", choice: "none", wantTools: nil},
		{name: "required", choice: "required", wantTools: []string{"getWeather", "getTime"}, directive: "Call at least one available tool."},
		{
			name:      "chat named function",
			choice:    map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "get_time"}},
			wantTools: []string{"getTime"},
			directive: `The client requires the tool "getTime"`,
		},
		{
			name:      "responses named function",
			choice:    map[string]interface{}{"type": "function", "name": "get_time"},
			wantTools: []string{"getTime"},
			directive: `The client requires the tool "getTime"`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := OpenAIToKiro(&OpenAIRequest{
				Model:      "claude-sonnet-4.5",
				Messages:   []OpenAIMessage{{Role: "user", Content: "weather in Paris?"}},
				Tools:      openAIChoiceTestTools("get_weather", "get_time"),
				ToolChoice: tc.choice,
			}, false)

			current := payload.ConversationState.CurrentMessage.UserInputMessage
			var got []string
			if current.UserInputMessageContext != nil {
				for _, tool := range current.UserInputMessageContext.Tools {
					got = append(got, tool.ToolSpecification.Name)
				}
			}
			if strings.Join(got, ",") != strings.Join(tc.wantTools, ",") {
				t.Fatalf("tools = %v, want %v", got, tc.wantTools)
			}
			if tc.directive == "" {
				if strings.Contains(current.Content, "The client requires") {
					t.Fatalf("unexpected directive in %q", current.Content)
				}
			} else if !strings.Contains(current.Content, tc.directive) {
				t.Fatalf("content %q missing directive %q", current.Content, tc.directive)
			}
		})
	}
}

func TestValidateOpenAIToolChoice(t *testing.T) {
	tools := openAIChoiceTestTools("get_weather")
	for _, tc := range []struct {
		name   string
		choice interface{}
		tools  []OpenAITool
		want   string
	}{
		{name: "auto", choice: "auto", tools: tools},
		{name: "none without tools", choice: "none"},
		{name: "required", choice: "required", tools: tools},
		{name: "required without tools", choice: "required", want: "tool_choice required requires tools"},
		{name: "declared name", choice: map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "get_weather"}}, tools: tools},
		{name: "undeclared name", choice: map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "get_time"}}, tools: tools, want: "tool_choice names an undeclared tool"},
		{name: "unknown string", choice: "sometimes", tools: tools, want: "unsupported tool_choice"},
		{name: "allowed_tools object stays ignored", choice: map[string]interface{}{"type": "allowed_tools"}, tools: tools},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := validateOpenAIToolChoice(&OpenAIRequest{Tools: tc.tools, ToolChoice: tc.choice})
			if got != tc.want {
				t.Fatalf("validateOpenAIToolChoice = %q, want %q", got, tc.want)
			}
		})
	}
}

// Live: tool_choice none on a turn answering a tool call got HTTP 400
// TOOL_CONFIG_MISSING, because the tool list was dropped while the structured
// toolUse/toolResult blocks stayed.
func TestToolChoiceNoneNarratesActiveToolTurn(t *testing.T) {
	payload := ClaudeToKiro(&ClaudeRequest{
		Model:      "claude-sonnet-4.5",
		Tools:      []ClaudeTool{{Name: "run_a", InputSchema: map[string]interface{}{"type": "object"}}},
		ToolChoice: map[string]interface{}{"type": "none"},
		Messages: []ClaudeMessage{
			{Role: "user", Content: "run it"},
			{Role: "assistant", Content: []interface{}{map[string]interface{}{"type": "tool_use", "id": "toolu_1", "name": "run_a", "input": map[string]interface{}{}}}},
			{Role: "user", Content: []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "toolu_1", "content": "RESULT-MARKER"}}},
		},
	}, false)

	current := payload.ConversationState.CurrentMessage.UserInputMessage
	if ctx := current.UserInputMessageContext; ctx != nil && (len(ctx.Tools) > 0 || len(ctx.ToolResults) > 0) {
		t.Fatalf("tool_choice none kept structured tool context: %+v", ctx)
	}
	for _, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil && len(a.ToolUses) > 0 {
			t.Fatalf("tool_choice none kept structured toolUses in history: %+v", a.ToolUses)
		}
	}
	if !strings.Contains(current.Content, "RESULT-MARKER") || !strings.Contains(current.Content, "[run_a]") {
		t.Fatalf("tool result not narrated into the user turn: %q", current.Content)
	}
}
