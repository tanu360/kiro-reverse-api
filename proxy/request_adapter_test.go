package proxy

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestAdapterPreservesLongCurrentTextAndWhitespace(t *testing.T) {
	want := "  [Image 1] actor\n\n" + strings.Repeat("完整剧本\n", 110000) + "FINAL_MARKER  \n"
	for _, protocol := range []string{"claude", "openai", "responses"} {
		t.Run(protocol, func(t *testing.T) {
			var payload *KiroPayload
			switch protocol {
			case "claude":
				payload = ClaudeToKiro(&ClaudeRequest{Model: "claude-opus-5.5", Messages: []ClaudeMessage{{Role: "user", Content: want}}}, false)
			case "openai":
				payload = OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-5.5", Messages: []OpenAIMessage{{Role: "user", Content: want}}}, false)
			case "responses":
				raw, _ := json.Marshal(want)
				prepared, msg := prepareResponsesRequest(&OpenAIResponsesRequest{Model: "claude-opus-5.5", Input: raw}, nil)
				if msg != "" {
					t.Fatal(msg)
				}
				payload = OpenAIToKiro(&prepared.OpenAIRequest, false)
			}
			if got := payload.ConversationState.CurrentMessage.UserInputMessage.Content; got != want {
				t.Fatalf("text changed: got %d bytes, want %d", len(got), len(want))
			}
		})
	}
}

func TestAdapterRetainsRepeatedUserTurns(t *testing.T) {
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-5.5", Messages: []OpenAIMessage{
		{Role: "user", Content: "  REPEAT\n"}, {Role: "user", Content: "  REPEAT\n"}, {Role: "user", Content: "FINAL"},
	}}, false)
	count := 0
	for _, history := range payload.ConversationState.History {
		if history.UserInputMessage != nil && history.UserInputMessage.Content == "  REPEAT\n" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("repeated messages were deduplicated: %d", count)
	}
}

func TestAdapterInferenceKeepsZeroAndOmission(t *testing.T) {
	var request OpenAIRequest
	if err := json.Unmarshal([]byte(`{"model":"claude-opus-5.5","max_completion_tokens":256,"temperature":0,"top_p":0,"messages":[{"role":"user","content":"test"}]}`), &request); err != nil {
		t.Fatal(err)
	}
	payload := OpenAIToKiro(&request, false)
	raw, _ := json.Marshal(payload)
	var wire map[string]interface{}
	_ = json.Unmarshal(raw, &wire)
	inference := wire["inferenceConfig"].(map[string]interface{})
	if inference["maxTokens"] != float64(256) || inference["temperature"] != float64(0) || inference["topP"] != float64(0) {
		t.Fatalf("parameters lost: %s", raw)
	}
	request.Temperature = nil
	request.TopP = nil
	payload = OpenAIToKiro(&request, false)
	raw, _ = json.Marshal(payload)
	_ = json.Unmarshal(raw, &wire)
	inference = wire["inferenceConfig"].(map[string]interface{})
	if _, exists := inference["temperature"]; exists {
		t.Fatal("omitted temperature was invented")
	}
	if _, exists := inference["topP"]; exists {
		t.Fatal("omitted top_p was invented")
	}
}

func TestAdapterDocumentsCacheAndContext(t *testing.T) {
	text := "Actor A is [Image 1].\n全文保留。"
	encoded := base64.StdEncoding.EncodeToString([]byte(text))
	for _, protocol := range []string{"claude", "openai", "responses"} {
		t.Run(protocol, func(t *testing.T) {
			block := map[string]interface{}{"type": "document", "title": "Actors", "source": map[string]interface{}{"type": "text", "media_type": "text/plain", "data": text}, "cache_control": map[string]interface{}{"type": "ephemeral"}}
			if protocol != "claude" {
				block = map[string]interface{}{"type": "file", "file": map[string]interface{}{"filename": "actors.txt", "file_data": "data:text/plain;base64," + encoded}, "cache_control": map[string]interface{}{"type": "ephemeral"}}
			}
			content := []interface{}{block}
			context := map[string]interface{}{"additionalContext": map[string]interface{}{"scene": "SCENE_1"}}
			var payload *KiroPayload
			if protocol == "claude" {
				req := &ClaudeRequest{Model: "claude-opus-5.5", ConversationID: "session-id", KiroContext: context, Messages: []ClaudeMessage{{Role: "user", Content: content}}}
				if msg := validateClaudeRequestShape(req); msg != "" {
					t.Fatal(msg)
				}
				payload = ClaudeToKiro(req, false)
			} else {
				req := &OpenAIRequest{Model: "claude-opus-5.5", ConversationID: "session-id", KiroContext: context, Messages: []OpenAIMessage{{Role: "user", Content: content}}}
				if protocol == "responses" {
					block["type"] = "input_file"
					block["filename"] = "actors.txt"
					block["file_data"] = "data:text/plain;base64," + encoded
					raw, _ := json.Marshal([]interface{}{map[string]interface{}{"role": "user", "content": content}})
					prepared, msg := prepareResponsesRequest(&OpenAIResponsesRequest{Model: req.Model, Input: raw, ConversationID: req.ConversationID, KiroContext: context}, nil)
					if msg != "" {
						t.Fatal(msg)
					}
					req = &prepared.OpenAIRequest
				}
				if msg := validateOpenAIRequestShape(req); msg != "" {
					t.Fatal(msg)
				}
				payload = OpenAIToKiro(req, false)
			}
			current := payload.ConversationState.CurrentMessage.UserInputMessage
			if len(current.Documents) != 1 || current.Documents[0].Source.Bytes != encoded {
				t.Fatalf("document data changed: %+v", current.Documents)
			}
			if current.CachePoint == nil || current.CachePoint.Type != "default" {
				t.Fatal("cache boundary lost")
			}
			if current.UserInputMessageContext == nil || current.UserInputMessageContext.AdditionalContext == nil {
				t.Fatal("context lost")
			}
			if payload.ConversationState.ConversationID != "session-id" {
				t.Fatal("explicit conversation ID lost")
			}
		})
	}
}

func TestAdapterToolArgumentsDescriptionsAndErrorsRetained(t *testing.T) {
	description := strings.Repeat("description ", 1500) + "DESC_TAIL"
	request := &ClaudeRequest{Model: "claude-opus-5.5", Tools: []ClaudeTool{{Name: "run", Description: description, InputSchema: map[string]interface{}{"type": "object"}}}, Messages: []ClaudeMessage{
		{Role: "user", Content: "run it"},
		{Role: "assistant", Content: []interface{}{map[string]interface{}{"type": "tool_use", "id": "call1", "name": "run", "input": map[string]interface{}{"cmd": "ARGUMENT_MARKER"}}}},
		{Role: "user", Content: []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "call1", "is_error": true, "content": "FAILURE_MARKER"}}},
	}}
	payload := ClaudeToKiro(request, false)
	current := payload.ConversationState.CurrentMessage.UserInputMessage
	if current.UserInputMessageContext.Tools[0].ToolSpecification.Description != description {
		t.Fatal("long description truncated")
	}
	if current.UserInputMessageContext.ToolResults[0].Status != "error" {
		t.Fatal("tool error status lost")
	}
	request.Messages = append(request.Messages, ClaudeMessage{Role: "user", Content: "summarize"})
	payload = ClaudeToKiro(request, false)
	raw, _ := json.Marshal(payload)
	for _, marker := range []string{"ARGUMENT_MARKER", "FAILURE_MARKER", "DESC_TAIL"} {
		if !strings.Contains(string(raw), marker) {
			t.Fatal("lost " + marker)
		}
	}
}

func TestAdapterRejectsUnsupportedInsteadOfIgnoring(t *testing.T) {
	var request OpenAIRequest
	for _, body := range []string{`{"stop":["END"]}`, `{"n":2}`, `{"seed":42}`, `{"mystery_parameter":true}`} {
		_ = json.Unmarshal([]byte(body), &request)
		if msg := validateRequestParameters([]byte(body), &request); msg == "" {
			t.Fatalf("silently accepted %s", body)
		}
	}
	if msg := validateRequestParameters([]byte(`{"stop":[],"n":1,"temperature":0}`), &request); msg != "" {
		t.Fatal(msg)
	}
	if msg := validateAdapterContent([]interface{}{map[string]interface{}{"type": "audio"}}, "user", false); msg == "" {
		t.Fatal("audio silently discarded")
	}
	if msg := validateAdapterContent([]interface{}{map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": "https://example.com/image.png"}}}, "user", false); msg == "" {
		t.Fatal("remote image silently discarded")
	}
}

func TestAdapterNativeThinkingPreservesFields(t *testing.T) {
	h := &Handler{cachedModels: []ModelInfo{{ModelId: "claude-opus-5.5", AdditionalModelRequestFieldsSchema: map[string]interface{}{"properties": map[string]interface{}{"thinking": map[string]interface{}{}, "output_config": map[string]interface{}{}}}}}}
	request := &ClaudeRequest{Model: "claude-opus-5.5", System: "  RULE\n", Thinking: &ClaudeThinkingConfig{Type: "adaptive", Display: "omitted"}, OutputConfig: map[string]interface{}{"effort": "max"}, AdditionalModelRequestFields: map[string]interface{}{"max_tokens": float64(2048)}, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}
	payload := ClaudeToKiro(request, true)
	h.applyAdapterThinking(payload, request.Model, request.Thinking, "")
	fields := payload.AdditionalModelRequestFields
	if fields["max_tokens"] != float64(2048) {
		t.Fatal("native extension overwritten")
	}
	if fields["output_config"].(map[string]interface{})["effort"] != "max" {
		t.Fatal("max effort changed")
	}
	if fields["thinking"].(map[string]interface{})["display"] != "omitted" {
		t.Fatal("display lost")
	}
	if payload.ConversationState.History[0].UserInputMessage.Content != "  RULE\n" {
		t.Fatal("native thinking changed client system text")
	}
	// A client-authored prefix is content, not an activation marker generated
	// by the proxy. Native effort without a thinking flag must not remove it.
	request.System = ThinkingModePrompt + "\n\nUSER_AUTHORED_PREFIX"
	request.Thinking = nil
	payload = ClaudeToKiro(request, false)
	h.applyAdapterThinking(payload, request.Model, nil, "")
	if payload.ConversationState.History[0].UserInputMessage.Content != request.System {
		t.Fatal("client-authored system prefix removed")
	}
}

func TestAdapterTextDocumentIsNotGuessedToBeAnImage(t *testing.T) {
	content := []interface{}{map[string]interface{}{"type": "document", "source": map[string]interface{}{"type": "text", "data": "test"}}}
	documents := documentsFromContent(content)
	if len(documents) != 1 || documents[0].Source.Bytes != base64.StdEncoding.EncodeToString([]byte("test")) {
		t.Fatal("a plain-text word that is valid base64 was misclassified")
	}
}

func TestAdapterToolCacheUsesUnionWireShape(t *testing.T) {
	tools, _ := convertClaudeTools([]ClaudeTool{{Name: "run", Description: "Run", InputSchema: map[string]interface{}{"type": "object"}, CacheControl: map[string]interface{}{"type": "ephemeral"}}})
	raw, err := json.Marshal(tools)
	if err != nil {
		t.Fatal(err)
	}
	var wire []map[string]interface{}
	_ = json.Unmarshal(raw, &wire)
	if len(wire) != 2 || wire[1]["cachePoint"] == nil || wire[1]["toolSpecification"] != nil {
		t.Fatalf("bad cache union: %s", raw)
	}
}

func TestAdapterColdModelCacheKeepsNativeThinking(t *testing.T) {
	h := &Handler{}
	request := &ClaudeRequest{Model: "claude-opus-5.5", Thinking: &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048}, MaxTokens: 4096, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}
	payload := ClaudeToKiro(request, true)
	h.applyAdapterThinking(payload, request.Model, request.Thinking, "")
	if payload.AdditionalModelRequestFields["thinking"].(map[string]interface{})["type"] != "adaptive" {
		t.Fatal("cold cache lost thinking")
	}
	if payload.AdditionalModelRequestFields["output_config"].(map[string]interface{})["effort"] != "low" {
		t.Fatal("cold cache lost budget mapping")
	}
	gpt := OpenAIToKiro(&OpenAIRequest{Model: "gpt-5.6-sol", Messages: []OpenAIMessage{{Role: "user", Content: "hi"}}}, false)
	h.applyAdapterThinking(gpt, "gpt-5.6-sol", nil, "max")
	if gpt.AdditionalModelRequestFields["reasoning"].(map[string]interface{})["effort"] != "max" {
		t.Fatal("GPT effort mapped to the wrong path")
	}
}

func TestAdapterNativeThinkingWithoutSystemHasNoEmptyHistory(t *testing.T) {
	h := &Handler{}
	request := &OpenAIRequest{Model: "gpt-5.6-sol", ReasoningEffort: "low", Messages: []OpenAIMessage{{Role: "user", Content: "CODE"}}}
	payload := OpenAIToKiro(request, true)
	h.applyAdapterThinking(payload, request.Model, nil, request.ReasoningEffort)
	if len(payload.ConversationState.History) != 0 {
		t.Fatalf("activation-only history retained: %+v", payload.ConversationState.History)
	}
	// A literal client-authored activation string remains client content even
	// when a second activation prefix was injected by the legacy adapter.
	claude := &ClaudeRequest{Model: "claude-opus-5.5", System: ThinkingModePrompt, Thinking: &ClaudeThinkingConfig{Type: "adaptive"}, Messages: []ClaudeMessage{{Role: "user", Content: "CODE"}}}
	payload = ClaudeToKiro(claude, true)
	h.applyAdapterThinking(payload, claude.Model, claude.Thinking, "")
	if payload.ConversationState.History[0].UserInputMessage.Content != ThinkingModePrompt {
		t.Fatal("literal client system content erased")
	}
}

func TestAdapterExplicitZeroTokenLimitIsRejected(t *testing.T) {
	for _, item := range []struct {
		Body    string
		Request interface{}
	}{
		{`{"max_tokens":0}`, &ClaudeRequest{}},
		{`{"max_completion_tokens":0}`, &OpenAIRequest{}},
		{`{"max_output_tokens":0}`, &OpenAIResponsesRequest{}},
	} {
		if msg := validateRequestParameters([]byte(item.Body), item.Request); msg == "" {
			t.Fatalf("zero token limit silently ignored: %s", item.Body)
		}
	}
}
