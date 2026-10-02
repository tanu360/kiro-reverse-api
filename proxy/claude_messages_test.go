package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestClaudeMessageSystemPreservesChronology(t *testing.T) {
	for _, tc := range []struct {
		name     string
		messages []ClaudeMessage
		want     []string
	}{
		{"before user", []ClaudeMessage{{Role: "system", Content: "DYNAMIC"}, {Role: "user", Content: "ASK"}}, []string{"DYNAMIC\nASK"}},
		{"after user", []ClaudeMessage{{Role: "user", Content: "ASK"}, {Role: "system", Content: "DYNAMIC"}}, []string{"ASK\nDYNAMIC"}},
		{"mid conversation", []ClaudeMessage{{Role: "user", Content: "OLD"}, {Role: "assistant", Content: "PAST"}, {Role: "system", Content: "DYNAMIC"}, {Role: "user", Content: "ASK"}}, []string{"OLD", "PAST", "DYNAMIC\nASK"}},
		{"consecutive systems", []ClaudeMessage{{Role: "user", Content: "OLD"}, {Role: "assistant", Content: "PAST"}, {Role: "system", Content: "FIRST"}, {Role: "system", Content: "SECOND"}, {Role: "user", Content: "ASK"}}, []string{"OLD", "PAST", "FIRST\nSECOND\nASK"}},
		{"before assistant", []ClaudeMessage{{Role: "user", Content: "OLD"}, {Role: "assistant", Content: "PAST"}, {Role: "system", Content: "DYNAMIC"}, {Role: "assistant", Content: "AFTER"}, {Role: "user", Content: "ASK"}}, []string{"OLD", "PAST", "DYNAMIC", "AFTER", "ASK"}},
		{"appended system", []ClaudeMessage{{Role: "user", Content: "OLD"}, {Role: "assistant", Content: "PAST"}, {Role: "system", Content: "DYNAMIC"}}, []string{"OLD", "PAST", "DYNAMIC"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 2048, Messages: tc.messages}
			if msg := validateClaudeRequestShape(request); msg != "" {
				t.Fatal(msg)
			}
			before, _ := json.Marshal(request)
			payload := ClaudeToKiro(request, false)
			var got []string
			for _, turn := range payload.ConversationState.History {
				if turn.UserInputMessage != nil {
					got = append(got, turn.UserInputMessage.Content)
				}
				if turn.AssistantResponseMessage != nil {
					got = append(got, turn.AssistantResponseMessage.Content)
				}
			}
			got = append(got, payload.ConversationState.CurrentMessage.UserInputMessage.Content)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("upstream turns = %#v, want %#v", got, tc.want)
			}
			after, _ := json.Marshal(request)
			if string(before) != string(after) {
				t.Fatal("conversion mutated the client request")
			}
		})
	}
}

func TestClaudeMessageSystemKeepsLargeTextLabelsAndCache(t *testing.T) {
	text := "  [Image 1]\n\n" + strings.Repeat("CONTENT", 140000) + "\nTAIL  "
	cache := map[string]interface{}{"type": "ephemeral", "ttl": "1h"}
	request := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 2048, Messages: []ClaudeMessage{
		{Role: "user", Content: "OLD"}, {Role: "assistant", Content: "PAST"},
		{Role: "system", Content: []interface{}{map[string]interface{}{"type": "text", "text": text, "cache_control": cache}}, CacheControl: cache},
		{Role: "user", Content: "ASK"},
	}}
	if msg := validateClaudeRequestShape(request); msg != "" {
		t.Fatal(msg)
	}
	before, _ := json.Marshal(request)
	payload := ClaudeToKiro(request, false)
	current := payload.ConversationState.CurrentMessage.UserInputMessage
	if current.Content != text+"\nASK" || current.CachePoint == nil {
		t.Fatal("system text, image label, whitespace or cache boundary lost")
	}
	after, _ := json.Marshal(request)
	if string(before) != string(after) {
		t.Fatal("cache conversion mutated the client request")
	}
}

func TestClaudeMessageSystemDoesNotInterruptToolResults(t *testing.T) {
	request := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 2048, Tools: []ClaudeTool{{Name: "run", InputSchema: map[string]interface{}{"type": "object"}}}, Messages: []ClaudeMessage{
		{Role: "user", Content: "ASK"},
		{Role: "assistant", Content: []interface{}{map[string]interface{}{"type": "tool_use", "id": "call1", "name": "run", "input": map[string]interface{}{}}}},
		{Role: "system", Content: "DYNAMIC"},
		{Role: "user", Content: []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "call1", "content": "RESULT"}}},
	}}
	if msg := validateClaudeRequestShape(request); msg != "" {
		t.Fatal(msg)
	}
	payload := ClaudeToKiro(request, false)
	current := payload.ConversationState.CurrentMessage.UserInputMessage
	if !strings.Contains(current.Content, "DYNAMIC") || current.UserInputMessageContext == nil || len(current.UserInputMessageContext.ToolResults) != 1 || current.UserInputMessageContext.ToolResults[0].ToolUseID != "call1" {
		t.Fatal("system instructions or native tool result pairing lost")
	}
	request.Messages[3].Content.([]interface{})[0].(map[string]interface{})["tool_use_id"] = "wrong"
	if validateClaudeRequestShape(request) == "" {
		t.Fatal("interleaved system bypassed tool ID validation")
	}
	request.Messages = request.Messages[:3]
	if validateClaudeRequestShape(request) == "" {
		t.Fatal("appended system bypassed missing tool result validation")
	}
}

func TestClaudeMessageSystemReachesUpstream(t *testing.T) {
	for _, stream := range []bool{false, true} {
		name := "nonstream"
		if stream {
			name = "stream"
		}
		t.Run(name, func(t *testing.T) {
			calls := 0
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var payload KiroPayload
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				current := payload.ConversationState.CurrentMessage.UserInputMessage
				if current.Content != "DYNAMIC\nASK" || current.CachePoint == nil || len(payload.ConversationState.History) != 2 {
					t.Errorf("unexpected upstream payload: %#v", payload.ConversationState)
				}
				writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "OK"}), meteringFrame(t))
			})
			body := map[string]interface{}{"model": "claude-sonnet-4.5", "max_tokens": 2048, "stream": stream, "messages": []interface{}{
				map[string]interface{}{"role": "user", "content": "OLD"}, map[string]interface{}{"role": "assistant", "content": "PAST"},
				map[string]interface{}{"role": "system", "content": "DYNAMIC", "cache_control": map[string]interface{}{"type": "ephemeral"}}, map[string]interface{}{"role": "user", "content": "ASK"},
			}}
			encoded, _ := json.Marshal(body)
			rec := postClaudeMessages(t, h, string(encoded))
			if rec.Code != 200 || calls != 1 || !strings.Contains(rec.Body.String(), "OK") {
				t.Fatalf("code=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
			}
			if stream && !strings.Contains(rec.Body.String(), "message_stop") {
				t.Fatal("stream did not complete")
			}
		})
	}
}

func TestClaudeMessageSystemDoesNotChangeOrdinaryMessages(t *testing.T) {
	messages := []ClaudeMessage{{Role: "user", Content: "ONE"}, {Role: "user", Content: "TWO"}, {Role: "assistant", Content: "PAST"}, {Role: "user", Content: "ASK"}}
	if got := normalizeClaudeMessageRoles(messages); !reflect.DeepEqual(got, messages) {
		t.Fatal("ordinary user turns were merged or changed")
	}
	request := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 2048, Messages: []ClaudeMessage{{Role: "developer", Content: "BAD"}, {Role: "user", Content: "ASK"}}}
	if validateClaudeRequestShape(request) == "" {
		t.Fatal("unknown Anthropic role was accepted")
	}
}
