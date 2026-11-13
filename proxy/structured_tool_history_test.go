package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func setStructuredToolHistoryForTest(t *testing.T, enabled bool) {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.UpdateStructuredToolHistory(enabled); err != nil {
		t.Fatalf("UpdateStructuredToolHistory: %v", err)
	}
	resetStructuredToolHistoryRejection()
	t.Cleanup(func() {
		_ = config.UpdateStructuredToolHistory(true)
		resetStructuredToolHistoryRejection()
	})
}

func testOpenAIFunctionTool(name string) OpenAITool {
	tool := OpenAITool{Type: "function"}
	tool.Function.Name = name
	tool.Function.Parameters = map[string]interface{}{"type": "object"}
	return tool
}

func openAIToolLoop(turns int, toolName string) []OpenAIMessage {
	msgs := []OpenAIMessage{{Role: "system", Content: "be an agent"}, {Role: "user", Content: "start a multi-step task"}}
	for i := 0; i < turns; i++ {
		msgs = append(msgs,
			OpenAIMessage{Role: "assistant", Content: fmt.Sprintf("Let me check step %d:", i), ToolCalls: []ToolCall{
				testToolCall(fmt.Sprintf("call_%d", i), toolName, fmt.Sprintf(`{"cmd":"step %d"}`, i)),
			}},
			OpenAIMessage{Role: "tool", ToolCallID: fmt.Sprintf("call_%d", i), Content: fmt.Sprintf("OUTPUT_%d", i)},
		)
	}
	return append(msgs, OpenAIMessage{Role: "user", Content: "keep going"})
}

// assertToolHistoryPaired fails when a structured toolUse or toolResult in history
// lacks its partner in the adjacent turn, which upstream rejects.
func assertToolHistoryPaired(t *testing.T, payload *KiroPayload) {
	t.Helper()
	history := payload.ConversationState.History
	var currentIDs map[string]bool
	if ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext; ctx != nil {
		currentIDs = collectToolResultIDs(ctx.ToolResults)
	}
	for i, h := range history {
		if a := h.AssistantResponseMessage; a != nil && len(a.ToolUses) > 0 {
			want := map[string]bool{}
			for _, tu := range a.ToolUses {
				want[tu.ToolUseID] = true
			}
			var got map[string]bool
			if i+1 < len(history) {
				if u := history[i+1].UserInputMessage; u != nil && u.UserInputMessageContext != nil {
					got = collectToolResultIDs(u.UserInputMessageContext.ToolResults)
				}
			} else {
				got = currentIDs
			}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("history[%d] toolUses %v not answered by the next turn (%v)", i, want, got)
			}
		}
		if u := h.UserInputMessage; u != nil && u.UserInputMessageContext != nil && len(u.UserInputMessageContext.ToolResults) > 0 {
			if i == 0 || history[i-1].AssistantResponseMessage == nil || len(history[i-1].AssistantResponseMessage.ToolUses) == 0 {
				t.Fatalf("history[%d] carries toolResults without a preceding toolUse turn", i)
			}
		}
	}
}

func TestStructuredToolHistoryDefaultsOn(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if !config.GetStructuredToolHistory() {
		t.Fatal("structured tool history must be on for a fresh install")
	}
}

func TestStructuredToolHistoryKeepsOpenAIToolCalls(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	req := &OpenAIRequest{Model: "claude-opus-4.8", Messages: openAIToolLoop(6, "exec_command"), Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}
	payload := OpenAIToKiro(req, false)

	calls, results := 0, 0
	for i, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil {
			if strings.Contains(a.Content, "[Called tool") {
				t.Fatalf("history[%d] narrates a tool call: %q", i, a.Content)
			}
			for _, tu := range a.ToolUses {
				calls++
				if tu.Name != "execCommand" {
					t.Fatalf("history[%d] toolUse name %q, want the declared Kiro name execCommand", i, tu.Name)
				}
			}
		}
		if u := h.UserInputMessage; u != nil {
			if strings.Contains(u.Content, toolResultsContinuationPrefix) {
				t.Fatalf("history[%d] narrates tool results that travel structured: %q", i, u.Content)
			}
			if strings.TrimSpace(u.Content) == "" {
				t.Fatalf("history[%d] user turn has empty content", i)
			}
			if u.UserInputMessageContext != nil {
				results += len(u.UserInputMessageContext.ToolResults)
			}
		}
	}
	if calls != 6 || results != 6 {
		t.Fatalf("structured history kept %d calls and %d results, want 6 and 6", calls, results)
	}
	assertToolHistoryPaired(t, payload)
}

func TestStructuredToolHistoryKeepsClaudeToolUses(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	msgs := []ClaudeMessage{{Role: "user", Content: "start"}}
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("toolu_%d", i)
		msgs = append(msgs,
			ClaudeMessage{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "text", "text": "Let me look:"},
				map[string]interface{}{"type": "tool_use", "id": id, "name": "Bash", "input": map[string]interface{}{"command": "ls"}},
			}},
			ClaudeMessage{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": id, "content": fmt.Sprintf("OUT_%d", i)},
			}},
		)
	}
	msgs = append(msgs, ClaudeMessage{Role: "user", Content: "next"})
	payload := ClaudeToKiro(&ClaudeRequest{
		Model: "claude-opus-4.8", Messages: msgs,
		Tools: []ClaudeTool{{Name: "Bash", InputSchema: map[string]interface{}{"type": "object"}}},
	}, false)

	calls := 0
	for _, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil {
			for _, tu := range a.ToolUses {
				calls++
				if tu.Name != "bash" {
					t.Fatalf("toolUse name %q, want declared Kiro name bash", tu.Name)
				}
			}
		}
	}
	if calls != 4 {
		t.Fatalf("kept %d structured tool calls, want 4", calls)
	}
	assertToolHistoryPaired(t, payload)
}

func TestStructuredToolHistoryOffNarrates(t *testing.T) {
	setStructuredToolHistoryForTest(t, false)
	req := &OpenAIRequest{Model: "claude-opus-4.8", Messages: openAIToolLoop(3, "exec_command"), Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}
	payload := OpenAIToKiro(req, false)
	assertNarratedToolHistory(t, payload, "exec_command", 3)
}

func assertNarratedToolHistory(t *testing.T, payload *KiroPayload, toolName string, outputs int) {
	t.Helper()
	var userText strings.Builder
	for i, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil && len(a.ToolUses) > 0 {
			t.Fatalf("history[%d] retains %d structured toolUses", i, len(a.ToolUses))
		}
		if u := h.UserInputMessage; u != nil {
			if u.UserInputMessageContext != nil && len(u.UserInputMessageContext.ToolResults) > 0 {
				t.Fatalf("history[%d] retains structured toolResults", i)
			}
			userText.WriteString(u.Content + "\n")
		}
	}
	for i := 0; i < outputs; i++ {
		if !strings.Contains(userText.String(), fmt.Sprintf("OUTPUT_%d", i)) {
			t.Fatalf("tool output %d lost from narrated history", i)
		}
	}
	if !strings.Contains(userText.String(), "["+toolName+"]") {
		t.Fatalf("narrated results not attributed to %s", toolName)
	}
}

func TestStructuredToolHistoryNeedsDeclaredTools(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	//! Upstream answers TOOL_CONFIG_MISSING for structured tool blocks in a request without tools.
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: openAIToolLoop(3, "exec_command")}, false)
	assertNarratedToolHistory(t, payload, "exec_command", 3)

	choiceNone := &OpenAIRequest{Model: "claude-opus-4.8", Messages: openAIToolLoop(3, "exec_command"), Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}, ToolChoice: "none"}
	assertNarratedToolHistory(t, OpenAIToKiro(choiceNone, false), "exec_command", 3)
}

func TestStructuredToolHistoryNarratesUndeclaredToolPairOnly(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	msgs := []OpenAIMessage{
		{Role: "user", Content: "start"},
		{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_old", "removed_tool", `{}`)}},
		{Role: "tool", ToolCallID: "call_old", Content: "OLD_OUTPUT"},
		{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_new", "read_file", `{"path":"a"}`)}},
		{Role: "tool", ToolCallID: "call_new", Content: "NEW_OUTPUT"},
		{Role: "user", Content: "go on"},
	}
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs, Tools: []OpenAITool{testOpenAIFunctionTool("read_file")}}, false)

	var narrated, structured bool
	for _, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil {
			for _, tu := range a.ToolUses {
				if tu.ToolUseID == "call_old" {
					t.Fatalf("undeclared tool call stayed structured")
				}
				if tu.ToolUseID == "call_new" && tu.Name == "readFile" {
					structured = true
				}
			}
		}
		if u := h.UserInputMessage; u != nil && strings.Contains(u.Content, "[removed_tool] OLD_OUTPUT") {
			narrated = true
		}
	}
	if !narrated || !structured {
		t.Fatalf("narrated=%v structured=%v, want the undeclared pair narrated and the declared pair structured", narrated, structured)
	}
	assertToolHistoryPaired(t, payload)
}

func TestStructuredToolHistoryNarratesUnpairedIDs(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	msgs := []OpenAIMessage{
		{Role: "user", Content: "start"},
		{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_a", "read_file", `{}`)}},
		{Role: "tool", ToolCallID: "call_other", Content: "MISMATCHED_OUTPUT"},
		{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_b", "read_file", `{}`), testToolCall("call_c", "read_file", `{}`)}},
		{Role: "tool", ToolCallID: "call_b", Content: "PARTIAL_OUTPUT"},
		{Role: "user", Content: "interrupted"},
		{Role: "assistant", ToolCalls: []ToolCall{testToolCall("call_d", "read_file", `{}`)}},
		{Role: "user", Content: "never answered"},
	}
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs, Tools: []OpenAITool{testOpenAIFunctionTool("read_file")}}, false)
	for i, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil && len(a.ToolUses) > 0 {
			t.Fatalf("history[%d] kept unpaired toolUses %+v", i, a.ToolUses)
		}
		if u := h.UserInputMessage; u != nil && u.UserInputMessageContext != nil && len(u.UserInputMessageContext.ToolResults) > 0 {
			t.Fatalf("history[%d] kept unpaired toolResults", i)
		}
	}
	text, _ := json.Marshal(payload.ConversationState.History)
	for _, want := range []string{"MISMATCHED_OUTPUT", "PARTIAL_OUTPUT"} {
		if !strings.Contains(string(text), want) {
			t.Fatalf("tool output %s lost", want)
		}
	}
}

func TestStructuredToolHistoryKeepsIdenticalResultTurns(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	msgs := []OpenAIMessage{{Role: "user", Content: "start"}}
	for i := 0; i < 5; i++ {
		msgs = append(msgs,
			OpenAIMessage{Role: "assistant", ToolCalls: []ToolCall{testToolCall(fmt.Sprintf("c%d", i), "exec_command", `{"cmd":"x"}`)}},
			OpenAIMessage{Role: "tool", ToolCallID: fmt.Sprintf("c%d", i), Content: "SAME_ERROR_OUTPUT"},
		)
	}
	msgs = append(msgs, OpenAIMessage{Role: "user", Content: "final"})
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs, Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}, false)
	//! Collapsing identical narrated turns must never drop a structured result: its toolUse would be orphaned.
	assertToolHistoryPaired(t, payload)
	results := 0
	for _, h := range payload.ConversationState.History {
		if u := h.UserInputMessage; u != nil && u.UserInputMessageContext != nil {
			results += len(u.UserInputMessageContext.ToolResults)
		}
	}
	if results != 5 {
		t.Fatalf("kept %d structured results, want 5", results)
	}
}

func TestStructuredToolHistoryKeepsActiveTurn(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	msgs := openAIToolLoop(3, "exec_command")
	msgs = msgs[:len(msgs)-1]
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs, Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}, false)
	ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
	if ctx == nil || len(ctx.ToolResults) != 1 || ctx.ToolResults[0].ToolUseID != "call_2" {
		t.Fatalf("current tool result not structured: %+v", ctx)
	}
	history := payload.ConversationState.History
	if last := history[len(history)-1].AssistantResponseMessage; last == nil || len(last.ToolUses) != 1 || last.ToolUses[0].Name != "execCommand" {
		t.Fatalf("active call must use the declared Kiro name like the rest of history: %+v", last)
	}
	assertToolHistoryPaired(t, payload)
}

func TestStructuredToolHistorySurvivesTruncation(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	//! Large call arguments with small results put the truncation cut between a
	//! toolUse turn and the toolResults that answer it.
	bigArgs := fmt.Sprintf(`{"blob":%q}`, strings.Repeat("x", 40*1024))
	msgs := []OpenAIMessage{{Role: "user", Content: "start"}}
	for i := 0; i < 40; i++ {
		msgs = append(msgs,
			OpenAIMessage{Role: "assistant", ToolCalls: []ToolCall{testToolCall(fmt.Sprintf("c%d", i), "exec_command", bigArgs)}},
			OpenAIMessage{Role: "tool", ToolCallID: fmt.Sprintf("c%d", i), Content: fmt.Sprintf("OUT_%d", i)},
		)
	}
	msgs = append(msgs, OpenAIMessage{Role: "user", Content: "keep going"})
	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs, Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}, false)

	history := payload.ConversationState.History
	text, _ := json.Marshal(history)
	if !strings.Contains(string(text), truncationPlaceholder) {
		t.Fatal("expected the history to be truncated")
	}
	assertToolHistoryPaired(t, payload)
	if !payloadHasStructuredToolHistory(payload) {
		t.Fatal("pairs that survived truncation intact must stay structured")
	}
	if !strings.Contains(string(text), "OUT_39") {
		t.Fatal("newest tool output lost")
	}
}

func TestStructuredToolHistoryRejectionFlattensForAnHour(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	build := func() *KiroPayload {
		return OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: openAIToolLoop(2, "exec_command"), Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}, false)
	}
	markStructuredToolHistoryRejected()
	assertNarratedToolHistory(t, build(), "exec_command", 2)

	structuredToolHistoryRejectedAt.Store(time.Now().Add(-structuredToolHistoryRejectionTTL - time.Minute).UnixNano())
	if p := build(); !payloadHasStructuredToolHistory(p) {
		t.Fatal("structured history must come back once the rejection expires")
	}
}

func TestFlattenStructuredToolHistoryMatchesNarratedMode(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	req := func() *OpenAIRequest {
		msgs := openAIToolLoop(3, "exec_command")
		return &OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs[:len(msgs)-1], Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}
	}
	structured := OpenAIToKiro(req(), false)
	if !flattenStructuredToolHistory(structured) {
		t.Fatal("expected structured history to be flattened")
	}
	if flattenStructuredToolHistory(structured) {
		t.Fatal("a flattened payload has nothing left to flatten")
	}
	if err := config.UpdateStructuredToolHistory(false); err != nil {
		t.Fatal(err)
	}
	narrated := OpenAIToKiro(req(), false)
	got, _ := json.Marshal(structured.ConversationState.History)
	want, _ := json.Marshal(narrated.ConversationState.History)
	if string(got) != string(want) {
		t.Fatalf("flattened history differs from narrated mode:\n got %s\nwant %s", got, want)
	}
}

func newToolHistoryUpstream(t *testing.T, statuses ...int) (*[]KiroPayload, func()) {
	t.Helper()
	if err := config.UpdatePreferredEndpoint("kiro"); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateEndpointFallback(false); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var seen []KiroPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var p KiroPayload
		_ = json.Unmarshal(body, &p)
		mu.Lock()
		n := len(seen)
		seen = append(seen, p)
		mu.Unlock()
		status := http.StatusOK
		if n < len(statuses) {
			status = statuses[n]
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"message":"Improperly formed request."}`))
			return
		}
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "ok"}), meteringFrame(t))
	}))
	oldEndpoints := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{{URL: server.URL, Origin: "AI_EDITOR", Name: "tool-history-test"}}
	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}})
	return &seen, func() {
		kiroHttpStore.Store(oldClient)
		kiroEndpoints = oldEndpoints
		server.Close()
	}
}

func structuredToolHistoryPayload() *KiroPayload {
	return OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: openAIToolLoop(2, "exec_command"), Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}, false)
}

func TestKiroBadRequestRetriesWithFlattenedToolHistory(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	seen, cleanup := newToolHistoryUpstream(t, http.StatusBadRequest)
	defer cleanup()
	logs := captureLogs(t)

	payload := structuredToolHistoryPayload()
	if !payloadHasStructuredToolHistory(payload) {
		t.Fatal("test payload must carry structured history")
	}
	account := &config.Account{ID: "a", AccessToken: "t", ProfileArn: "arn:aws:codewhisperer:profile/a"}
	var text strings.Builder
	err := CallKiroAPIContext(context.Background(), account, payload, &KiroStreamCallback{OnText: func(s string, _ bool) { text.WriteString(s) }})
	if err != nil {
		t.Fatalf("retry with flattened history failed: %v", err)
	}
	if len(*seen) != 2 {
		t.Fatalf("upstream saw %d requests, want 2", len(*seen))
	}
	if !payloadHasStructuredToolHistory(&(*seen)[0]) || payloadHasStructuredToolHistory(&(*seen)[1]) {
		t.Fatal("expected a structured first attempt and a flattened retry")
	}
	if text.String() != "ok" {
		t.Fatalf("text = %q", text.String())
	}
	if structuredToolHistoryEnabled() {
		t.Fatal("a confirmed rejection must switch structured history off for a while")
	}
	if payloadHasStructuredToolHistory(structuredToolHistoryPayload()) {
		t.Fatal("later requests must flatten directly after a confirmed rejection")
	}
	if want := "narrating tool history for the next 1h\n"; !strings.Contains(logs.String(), want) {
		t.Fatalf("missing %q in logs:\n%s", want, logs)
	}
}

func TestKiroBadRequestWithoutStructuredHistoryIsNotRetried(t *testing.T) {
	setStructuredToolHistoryForTest(t, false)
	seen, cleanup := newToolHistoryUpstream(t, http.StatusBadRequest, http.StatusBadRequest)
	defer cleanup()
	account := &config.Account{ID: "a", AccessToken: "t", ProfileArn: "arn:aws:codewhisperer:profile/a"}
	err := CallKiroAPIContext(context.Background(), account, structuredToolHistoryPayload(), &KiroStreamCallback{})
	if !isUpstreamClientError(err) {
		t.Fatalf("err = %v, want the upstream 400", err)
	}
	if len(*seen) != 1 {
		t.Fatalf("upstream saw %d requests, want 1", len(*seen))
	}
}

func TestKiroBadRequestUnrelatedToToolHistoryIsNotRemembered(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	seen, cleanup := newToolHistoryUpstream(t, http.StatusBadRequest, http.StatusBadRequest)
	defer cleanup()
	account := &config.Account{ID: "a", AccessToken: "t", ProfileArn: "arn:aws:codewhisperer:profile/a"}
	err := CallKiroAPIContext(context.Background(), account, structuredToolHistoryPayload(), &KiroStreamCallback{})
	if !isUpstreamClientError(err) {
		t.Fatalf("err = %v, want the upstream 400", err)
	}
	if len(*seen) != 2 {
		t.Fatalf("upstream saw %d requests, want one retry", len(*seen))
	}
	if !structuredToolHistoryEnabled() {
		t.Fatal("a 400 that the flattened retry also gets is not caused by tool history")
	}
}

func TestSettingsToggleStructuredToolHistory(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	h := &Handler{}
	rec := httptest.NewRecorder()
	h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(`{"structuredToolHistory":false}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if config.GetStructuredToolHistory() {
		t.Fatal("setting was not saved")
	}
	rec = httptest.NewRecorder()
	h.apiGetSettings(rec, httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil))
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if v, ok := got["structuredToolHistory"].(bool); !ok || v {
		t.Fatalf("settings GET structuredToolHistory = %#v, want false", got["structuredToolHistory"])
	}
}

func TestStructuredToolHistoryResponsesNamespaceCall(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	prepared, msg := prepareResponsesRequest(&OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`[{"type":"message","role":"user","content":"delegate"},` +
			`{"type":"function_call","call_id":"call_1","namespace":"collaboration","name":"spawn_agent","arguments":"{\"task\":\"x\"}"},` +
			`{"type":"function_call_output","call_id":"call_1","output":"agent a1 started"},` +
			`{"type":"message","role":"user","content":"now wait for it"}]`),
		Tools: []OpenAIResponsesTool{{Type: "namespace", Name: "collaboration", Tools: []OpenAIResponsesTool{
			{Type: "function", Name: "spawn_agent", Parameters: map[string]interface{}{"type": "object"}},
		}}},
	}, nil)
	if msg != "" {
		t.Fatal(msg)
	}
	payload := OpenAIToKiro(&prepared.OpenAIRequest, false)
	found := false
	for _, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil {
			for _, tu := range a.ToolUses {
				found = tu.ToolUseID == "call_1" && tu.Name == "collaborationSpawnAgent"
			}
		}
	}
	if !found {
		t.Fatalf("namespaced call not kept under its declared Kiro name: %+v", payload.ConversationState.History)
	}
	assertToolHistoryPaired(t, payload)
}

func TestKiroBadRequestRetryFailingForOtherReasonsIsNotRemembered(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			setStructuredToolHistoryForTest(t, true)
			_, cleanup := newToolHistoryUpstream(t, http.StatusBadRequest, status, status, status, status)
			defer cleanup()
			account := &config.Account{ID: "a", AccessToken: "t", ProfileArn: "arn:aws:codewhisperer:profile/a"}
			if err := CallKiroAPIContext(context.Background(), account, structuredToolHistoryPayload(), &KiroStreamCallback{}); err == nil {
				t.Fatal("expected the retry's failure to surface")
			}
			if !structuredToolHistoryEnabled() {
				t.Fatalf("a narrated retry that never reached a stream (HTTP %d) proves nothing about tool history", status)
			}
		})
	}
}
