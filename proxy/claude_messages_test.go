package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func kiroTurnTexts(payload *KiroPayload) []string {
	var got []string
	for _, turn := range payload.ConversationState.History {
		if turn.UserInputMessage != nil {
			got = append(got, turn.UserInputMessage.Content)
		}
		if turn.AssistantResponseMessage != nil {
			got = append(got, turn.AssistantResponseMessage.Content)
		}
	}
	return append(got, payload.ConversationState.CurrentMessage.UserInputMessage.Content)
}

func TestClaudeSystemMessagesKeepChronology(t *testing.T) {
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
		{"block content", []ClaudeMessage{{Role: "system", Content: []interface{}{map[string]interface{}{"type": "text", "text": "  keep\n\n  spacing"}}}, {Role: "user", Content: "ASK"}}, []string{"keep\n\n  spacing\nASK"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 2048, Messages: tc.messages}
			if msg := validateClaudeRequestShape(req); msg != "" {
				t.Fatal(msg)
			}
			before, _ := json.Marshal(req)
			if got := kiroTurnTexts(ClaudeToKiro(req, false)); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("upstream turns = %#v, want %#v", got, tc.want)
			}
			after, _ := json.Marshal(req)
			if string(before) != string(after) {
				t.Fatal("conversion mutated the client request")
			}
		})
	}
}

func TestClaudeSystemMessageKeepsToolResultPairing(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 2048,
		Tools: []ClaudeTool{{Name: "run", InputSchema: map[string]interface{}{"type": "object"}}},
		Messages: []ClaudeMessage{
			{Role: "user", Content: "ASK"},
			{Role: "assistant", Content: []interface{}{map[string]interface{}{"type": "tool_use", "id": "call1", "name": "run", "input": map[string]interface{}{}}}},
			{Role: "system", Content: "DYNAMIC"},
			{Role: "user", Content: []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "call1", "content": "RESULT"}}},
		}}
	cur := ClaudeToKiro(req, false).ConversationState.CurrentMessage.UserInputMessage
	if !strings.Contains(cur.Content, "DYNAMIC") || cur.UserInputMessageContext == nil || len(cur.UserInputMessageContext.ToolResults) != 1 || cur.UserInputMessageContext.ToolResults[0].ToolUseID != "call1" {
		t.Fatalf("system text or tool result pairing lost: %#v", cur)
	}
}

func TestClaudeOrdinaryMessagesAreNotMerged(t *testing.T) {
	messages := []ClaudeMessage{{Role: "user", Content: "ONE"}, {Role: "user", Content: "TWO"}, {Role: "assistant", Content: "PAST"}, {Role: "user", Content: "ASK"}}
	if got := normalizeClaudeMessageRoles(messages); !reflect.DeepEqual(got, messages) {
		t.Fatal("ordinary user turns were merged or changed")
	}
}

func TestClaudeSystemMessageReachesUpstream(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{false: "nonstream", true: "stream"}[stream], func(t *testing.T) {
			calls := 0
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var payload KiroPayload
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if got := payload.ConversationState.CurrentMessage.UserInputMessage.Content; got != "DYNAMIC\nASK" || len(payload.ConversationState.History) != 2 {
					t.Errorf("current=%q history=%d", got, len(payload.ConversationState.History))
				}
				writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "OK"}), meteringFrame(t))
			})
			body, _ := json.Marshal(map[string]interface{}{"model": "claude-sonnet-4.5", "max_tokens": 2048, "stream": stream, "messages": []interface{}{
				map[string]interface{}{"role": "user", "content": "OLD"},
				map[string]interface{}{"role": "assistant", "content": "PAST"},
				map[string]interface{}{"role": "system", "content": "DYNAMIC"},
				map[string]interface{}{"role": "user", "content": "ASK"},
			}})
			rec := postClaudeMessages(t, h, string(body))
			if rec.Code != 200 || calls != 1 || !strings.Contains(rec.Body.String(), "OK") {
				t.Fatalf("code=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
			}
		})
	}
}
