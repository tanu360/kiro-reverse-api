package proxy

import (
	"context"
	"strings"
	"testing"
)

func forcedToolPayload(choice string) *KiroPayload {
	req := &OpenAIRequest{
		Model:      "claude-haiku-4.5",
		Messages:   []OpenAIMessage{{Role: "user", Content: "Hi there!"}},
		ToolChoice: map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "get_weather"}},
	}
	if choice == "any" {
		req.ToolChoice = "required"
	}
	tool := OpenAITool{Type: "function"}
	tool.Function.Name = "get_weather"
	tool.Function.Parameters = map[string]interface{}{"type": "object", "properties": map[string]interface{}{"city": map[string]interface{}{"type": "string"}}}
	req.Tools = []OpenAITool{tool}
	return OpenAIToKiro(req, false)
}

func TestForcedToolChoiceAsksAgainWhenTheReplyMakesNoCall(t *testing.T) {
	payload := forcedToolPayload("tool")
	if payload.ForcedToolChoice != "tool" {
		t.Fatalf("a named tool_choice must mark the payload, got %q", payload.ForcedToolChoice)
	}
	script := &scriptedKiro{hops: []scriptedHop{
		{text: []string{"Which city would you like the weather for?"}, stop: "end_turn", in: 10, out: 9},
		{tools: []KiroToolUse{{ToolUseID: "t1", Name: "get_weather", Input: map[string]interface{}{"city": ""}}}, stop: "tool_use", in: 30, out: 12},
	}}
	rec := &continueRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, payload, rec.callback(), script.call); err != nil {
		t.Fatal(err)
	}
	if len(rec.tools) != 1 || rec.tools[0].Name != "get_weather" || rec.text != "" {
		t.Fatalf("tools %v text %q: want the second try's call and no first-try text", rec.tools, rec.text)
	}
	if rec.in != 40 || rec.out != 21 {
		t.Fatalf("usage %d/%d, want both tries billed", rec.in, rec.out)
	}
	upstream := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext.Tools[0].ToolSpecification.Name
	if len(script.payloads) != 2 || !strings.Contains(script.payloads[1].ConversationState.CurrentMessage.UserInputMessage.Content, `requires the tool "`+upstream+`"`) {
		t.Fatalf("the second try must name the required tool %q", upstream)
	}
	if script.payloads[1].ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext == nil {
		t.Fatalf("the second try must still declare the tool")
	}
}

func TestForcedToolChoicePassesACallThroughAtOnce(t *testing.T) {
	script := &scriptedKiro{hops: []scriptedHop{
		{text: []string{"Checking."}, tools: []KiroToolUse{{ToolUseID: "t1", Name: "get_weather", Input: map[string]interface{}{"city": "Paris"}}}, stop: "tool_use"},
	}}
	rec := &continueRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, forcedToolPayload("any"), rec.callback(), script.call); err != nil {
		t.Fatal(err)
	}
	if len(script.payloads) != 1 || len(rec.tools) != 1 || rec.text != "Checking." {
		t.Fatalf("calls %d tools %v text %q", len(script.payloads), rec.tools, rec.text)
	}
}

func TestForcedToolChoiceKeepsTheFirstReplyWhenTheRetryAlsoTalks(t *testing.T) {
	script := &scriptedKiro{hops: []scriptedHop{
		{text: []string{"Which city?"}, stop: "end_turn"},
		{text: []string{"I still need a city."}, stop: "end_turn"},
	}}
	rec := &continueRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, forcedToolPayload("tool"), rec.callback(), script.call); err != nil {
		t.Fatal(err)
	}
	if rec.text != "Which city?" || len(rec.tools) != 0 {
		t.Fatalf("text %q tools %v, want the first reply", rec.text, rec.tools)
	}
}

func TestAutoToolChoiceIsNotForced(t *testing.T) {
	req := &OpenAIRequest{Model: "m", Messages: []OpenAIMessage{{Role: "user", Content: "hi"}}}
	tool := OpenAITool{Type: "function"}
	tool.Function.Name = "f"
	req.Tools = []OpenAITool{tool}
	if p := OpenAIToKiro(req, false); p.ForcedToolChoice != "" {
		t.Fatalf("auto tool_choice marked as forced: %q", p.ForcedToolChoice)
	}
}
