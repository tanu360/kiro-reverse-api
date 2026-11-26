package proxy

import (
	"context"
	"encoding/json"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// legacyHistoryAssistants decodes the generateAssistantResponse body of payload and returns
// its history assistant messages in order, as raw JSON objects.
func legacyHistoryAssistants(t *testing.T, payload *KiroPayload) []map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return legacyBodyAssistants(t, raw)
}

func legacyBodyAssistants(t *testing.T, raw []byte) []map[string]interface{} {
	t.Helper()
	var body struct {
		ConversationState struct {
			History []struct {
				AssistantResponseMessage map[string]interface{} `json:"assistantResponseMessage"`
			} `json:"history"`
		} `json:"conversationState"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	var out []map[string]interface{}
	for _, h := range body.ConversationState.History {
		//! Like claudeHistoryAssistants: the system priming pair is not a converted turn.
		if a := h.AssistantResponseMessage; a != nil && a["content"] != "I will follow these instructions." {
			out = append(out, a)
		}
	}
	return out
}

// assertLegacyReasoningText checks the reasoningContent of the i-th history assistant; an
// empty text means the message must carry none.
func assertLegacyReasoningText(t *testing.T, payload *KiroPayload, i int, text, signature string) {
	t.Helper()
	assistants := legacyHistoryAssistants(t, payload)
	if i >= len(assistants) {
		t.Fatalf("history has %d assistants, want index %d", len(assistants), i)
	}
	rc, present := assistants[i]["reasoningContent"]
	if text == "" {
		if present {
			t.Fatalf("assistant %d carries reasoningContent %v, want none", i, rc)
		}
		return
	}
	want := map[string]interface{}{"reasoningText": map[string]interface{}{"text": text, "signature": signature}}
	if got, _ := json.Marshal(rc); string(got) != string(mustJSON(t, want)) {
		t.Fatalf("assistant %d reasoningContent = %s, want %s", i, got, mustJSON(t, want))
	}
}

func assertLegacyRedacted(t *testing.T, payload *KiroPayload, i int, data string) {
	t.Helper()
	assistants := legacyHistoryAssistants(t, payload)
	if i >= len(assistants) {
		t.Fatalf("history has %d assistants, want index %d", len(assistants), i)
	}
	want := map[string]interface{}{"redactedContent": data}
	if got, _ := json.Marshal(assistants[i]["reasoningContent"]); string(got) != string(mustJSON(t, want)) {
		t.Fatalf("assistant %d reasoningContent = %s, want %s", i, got, mustJSON(t, want))
	}
}

// assertNoThinkingText fails when the payload carries thinking as text, or any of secrets.
func assertNoThinkingText(t *testing.T, payload *KiroPayload, secrets ...string) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	//! json.Marshal writes < as <, so the escaped tag is the one a payload would carry.
	for _, s := range append(secrets, "<thinking>", "\\u003cthinking\\u003e") {
		if strings.Contains(string(raw), s) {
			t.Fatalf("Kiro payload carries %q: %s", s, raw)
		}
	}
}

// newRawLegacyUpstream is a generateAssistantResponse endpoint that answers the given
// statuses in turn (then 200 "ok") and keeps every request body as sent.
func newRawLegacyUpstream(t *testing.T, errBody string, statuses ...int) *[][]byte {
	t.Helper()
	if err := config.UpdatePreferredEndpoint("kiro"); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateEndpointFallback(false); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var seen [][]byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		n := len(seen)
		seen = append(seen, body)
		mu.Unlock()
		if n < len(statuses) && statuses[n] != http.StatusOK {
			w.WriteHeader(statuses[n])
			_, _ = w.Write([]byte(errBody))
			return
		}
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "ok"}), meteringFrame(t))
	}))
	oldEndpoints := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{{URL: server.URL, Origin: "AI_EDITOR", Name: "reasoning-test"}}
	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}})
	t.Cleanup(func() {
		kiroHttpStore.Store(oldClient)
		kiroEndpoints = oldEndpoints
		server.Close()
	})
	return &seen
}

func reasoningTestAccount() *config.Account {
	return &config.Account{ID: "reasoning", AccessToken: "t", ProfileArn: "arn:aws:codewhisperer:profile/a"}
}

// signatureRejectedBody is Kiro's 400 for a replayed thinking signature it does not accept
// (recorded live from both chat APIs; the backticks around signature and thinking dropped).
const signatureRejectedBody = `{"message":"messages.5.content.0: Invalid signature in thinking block","reason":"THINKING_SIGNATURE_INVALID"}`

func TestKiroSignatureRejectionRetriesWithoutReasoning(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	seen := newRawLegacyUpstream(t, signatureRejectedBody, http.StatusBadRequest)
	logs := captureLogs(t)

	payload := ClaudeToKiro(finishedTurnRequest("claude-sonnet-5"), true)
	var text strings.Builder
	err := CallKiroAPIContext(context.Background(), reasoningTestAccount(), payload, &KiroStreamCallback{OnText: func(s string, _ bool) { text.WriteString(s) }})
	if err != nil || text.String() != "ok" {
		t.Fatalf("err = %v text = %q", err, text.String())
	}
	if len(*seen) != 2 {
		t.Fatalf("upstream saw %d requests, want 2", len(*seen))
	}
	first, second := legacyBodyAssistants(t, (*seen)[0]), legacyBodyAssistants(t, (*seen)[1])
	if len(first) != 2 || len(second) != 2 {
		t.Fatalf("history assistants: %d then %d, want 2", len(first), len(second))
	}
	if _, ok := first[1]["reasoningContent"]; !ok {
		t.Fatalf("first attempt carries no reasoning: %s", (*seen)[0])
	}
	for i, a := range second {
		if _, ok := a["reasoningContent"]; ok {
			t.Fatalf("retry assistant %d still carries reasoning: %s", i, (*seen)[1])
		}
	}
	//! Dropping the reasoning keeps everything else: the tool use is still structured.
	if tu, _ := second[1]["toolUses"].([]interface{}); len(tu) != 1 {
		t.Fatalf("retry lost the tool use: %s", (*seen)[1])
	}
	if want := "Kiro rejected the replayed reasoning"; !strings.Contains(logs.String(), want) {
		t.Fatalf("missing %q in logs:\n%s", want, logs)
	}
	//! Account failover sends the caller's payload again: it keeps its reasoning.
	if !legacyReplaysReasoning(payload) {
		t.Fatal("the retry stripped the caller's payload")
	}
}

// reasoningOnlyPayload is a turn whose history replays reasoning and no tool use, so only the
// reasoning fallback can retry a 400.
func reasoningOnlyPayload(blocks ...KiroReasoningBlock) *KiroPayload {
	payload := testKiroPayload()
	payload.ConversationState.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{Content: "think", ModelID: "claude-sonnet-5", Origin: "AI_EDITOR"}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: "done", Reasoning: blocks}},
	}
	return payload
}

func TestKiroSignatureRejectionSkipsOtherEndpoints(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	seen := newRawLegacyUpstream(t, signatureRejectedBody, http.StatusBadRequest)
	if err := config.UpdateEndpointFallback(true); err != nil {
		t.Fatal(err)
	}
	url := kiroEndpoints[0].URL
	kiroEndpoints = []kiroEndpoint{{URL: url, Origin: "AI_EDITOR", Name: "first"}, {URL: url, Origin: "AI_EDITOR", Name: "second"}}

	payload := reasoningOnlyPayload(KiroReasoningBlock{Text: "a", Signature: "s1"})
	if err := CallKiroAPIContext(context.Background(), reasoningTestAccount(), payload, &KiroStreamCallback{}); err != nil {
		t.Fatalf("call: %v", err)
	}
	//! Every endpoint rejects the same signature: the retry without it comes next, not the
	//! second endpoint with it.
	if len(*seen) != 2 {
		t.Fatalf("upstream saw %d requests, want 2", len(*seen))
	}
	if a := legacyBodyAssistants(t, (*seen)[1]); len(a) != 1 || a[0]["reasoningContent"] != nil {
		t.Fatalf("second request still replays the reasoning: %s", (*seen)[1])
	}
}

func TestKiroSignatureRejectionWithUnsentReasoningIsNotRetried(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	seen := newRawLegacyUpstream(t, signatureRejectedBody, http.StatusBadRequest, http.StatusBadRequest)
	//! Two blocks do not fit generateAssistantResponse's reasoningContent, so none was sent.
	payload := reasoningOnlyPayload(KiroReasoningBlock{Text: "a", Signature: "s1"}, KiroReasoningBlock{Text: "b", Signature: "s2"})
	if err := CallKiroAPIContext(context.Background(), reasoningTestAccount(), payload, &KiroStreamCallback{}); !isReasoningRejection(err) {
		t.Fatalf("err = %v, want the rejection", err)
	}
	if len(*seen) != 1 {
		t.Fatalf("upstream saw %d requests, want 1: the retry would resend the same body", len(*seen))
	}
}

func TestKiroOtherBadRequestIsNotRetriedWithoutReasoning(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	for _, body := range []string{
		`{"message":"Improperly formed request."}`,
		`{"message":"Invalid model. Please select a different model to continue.","reason":"INVALID_MODEL_ID"}`,
	} {
		seen := newRawLegacyUpstream(t, body, http.StatusBadRequest, http.StatusBadRequest)
		payload := reasoningOnlyPayload(KiroReasoningBlock{Text: "a", Signature: "s1"})
		if err := CallKiroAPIContext(context.Background(), reasoningTestAccount(), payload, &KiroStreamCallback{}); !isUpstreamBadRequest(err) {
			t.Fatalf("%s: err = %v, want the 400", body, err)
		}
		if len(*seen) != 1 {
			t.Fatalf("%s: upstream saw %d requests, want 1", body, len(*seen))
		}
	}
}

func TestPayloadByteSizeCountsReasoningOutsideTheJSON(t *testing.T) {
	none := reasoningOnlyPayload()
	two := reasoningOnlyPayload(KiroReasoningBlock{Text: strings.Repeat("a", 1000), Signature: "s1"}, KiroReasoningBlock{Text: strings.Repeat("b", 1000), Signature: "s2"})
	//! CreateResponse sends both blocks though the legacy JSON holds neither.
	if got := payloadByteSize(two) - payloadByteSize(none); got < 2000 {
		t.Fatalf("two blocks add %d bytes to the payload size, want their 2000+", got)
	}
	if historyEntryByteSize(two.ConversationState.History[1]) < 2000 {
		t.Fatalf("history entry size = %d, want its reasoning counted", historyEntryByteSize(two.ConversationState.History[1]))
	}
}

func TestKiroContextOverflowIsNotRetriedWithoutReasoning(t *testing.T) {
	setStructuredToolHistoryForTest(t, true)
	seen := newRawLegacyUpstream(t, `{"message":"Input is too long.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}`, http.StatusBadRequest, http.StatusBadRequest)

	payload := ClaudeToKiro(finishedTurnRequest("claude-sonnet-5"), true)
	err := CallKiroAPIContext(context.Background(), reasoningTestAccount(), payload, &KiroStreamCallback{})
	if !isContextOverflowError(err) {
		t.Fatalf("err = %v, want the overflow", err)
	}
	if len(*seen) != 1 {
		t.Fatalf("upstream saw %d requests, want 1", len(*seen))
	}
	for i, body := range *seen {
		if a := legacyBodyAssistants(t, body); len(a) < 2 || a[1]["reasoningContent"] == nil {
			t.Fatalf("request %d dropped the reasoning for an overflow: %s", i, body)
		}
	}
}
