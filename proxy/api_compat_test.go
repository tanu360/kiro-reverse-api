package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestPDFIsADocumentNeverAnImage(t *testing.T) {
	block := map[string]interface{}{"type": "document", "source": map[string]interface{}{"type": "base64", "media_type": "application/pdf", "data": base64.StdEncoding.EncodeToString([]byte("%PDF-1.4\n"))}}
	if extractImageFromClaudeBlock(block) != nil {
		t.Fatal("PDF classified as image")
	}
	docs := documentsFromContent([]interface{}{block})
	if len(docs) != 1 || docs[0].Format != "pdf" {
		t.Fatal("PDF document lost")
	}
}

func TestNativeThinkingSuffixAvoidsLegacyInjection(t *testing.T) {
	p := ClaudeToKiro(&ClaudeRequest{Model: "claude-opus-5.5", Messages: []ClaudeMessage{{Role: "user", Content: "hello"}}}, true)
	h := &Handler{}
	h.applyAdapterThinking(p, "claude-opus-5.5", nil, "")
	if len(p.ConversationState.History) != 0 || p.AdditionalModelRequestFields["thinking"].(map[string]interface{})["type"] != "adaptive" {
		t.Fatal("suffix still uses legacy budget")
	}
}

func TestModelControlsRejectKnownIgnoredParameters(t *testing.T) {
	h := &Handler{}
	for _, out := range []map[string]interface{}{{"format": map[string]interface{}{"type": "json_schema"}}, {"effort": "invalid"}} {
		if h.validateModelControls("claude-opus-5.5", 1024, nil, nil, nil, out, nil) == "" {
			t.Fatal("ignored output option accepted")
		}
	}
	temp := 1.5
	if h.validateModelControls("claude-opus-5-5", 1024, &temp, nil, nil, nil, nil) == "" {
		t.Fatal("unsupported sampling accepted")
	}
	if h.validateModelControls("claude-opus-5.5", 500000, nil, nil, nil, nil, nil) == "" {
		t.Fatal("excessive cap accepted")
	}
}

func TestToolResultIDsAreValidated(t *testing.T) {
	messages := []ClaudeMessage{{Role: "assistant", Content: []interface{}{map[string]interface{}{"type": "tool_use", "id": "good", "name": "run", "input": map[string]interface{}{}}}}, {Role: "user", Content: []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "bad", "content": "result"}}}}
	if validateClaudeToolPairs(messages) == "" {
		t.Fatal("mismatched ID accepted")
	}
	messages[1].Content.([]interface{})[0].(map[string]interface{})["tool_use_id"] = "good"
	if msg := validateClaudeToolPairs(messages); msg != "" {
		t.Fatal(msg)
	}
}

func TestRemoteImagesRejectInternalHostsAndLeaveTextAlone(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "::1", "169.254.169.254", "10.0.0.1", "100.100.100.200", "::ffff:127.0.0.1"} {
		ip, _ := netip.ParseAddr(s)
		if publicImageIP(ip) {
			t.Fatal("unsafe image IP", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "2606:4700:4700::1111"} {
		ip, _ := netip.ParseAddr(s)
		if !publicImageIP(ip) {
			t.Fatal("public IP denied")
		}
	}
	body := []byte(`{"messages":[{"role":"user","content":"http://127.0.0.1/private"}],"tools":[{"input_schema":{"type":"image","url":"http://127.0.0.1/private"}}]}`)
	got, err := normalizeRemoteImages(context.Background(), body)
	if err != nil || string(got) != string(body) {
		t.Fatal("ordinary text rewritten or fetched")
	}
	bad := []byte(`{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"http://127.0.0.1/private"}}]}]}`)
	if _, err := normalizeRemoteImages(context.Background(), bad); err == nil {
		t.Fatal("private URL accepted")
	}
	var raw map[string]interface{}
	if json.Unmarshal(body, &raw) != nil {
		t.Fatal("fixture")
	}
}

func TestInvalidNativeOptionsStayLocal(t *testing.T) {
	calls := 0
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "unexpected upstream request", 500)
	})
	for _, body := range []string{
		`{"model":"claude-opus-5.5","max_tokens":2048,"additional_model_request_fields":{"max_tokens":16},"messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"claude-opus-5.5","max_tokens":500000,"messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"claude-opus-5.5","max_tokens":2048,"output_config":{"format":{"type":"json_schema"}},"messages":[{"role":"user","content":"hi"}]}`,
	} {
		rec := postClaudeMessages(t, h, body)
		if rec.Code != 400 {
			t.Fatalf("expected local 400: %d %s", rec.Code, rec.Body.String())
		}
	}
	if calls != 0 {
		t.Fatalf("invalid options sent upstream %d times", calls)
	}
}

func TestInvalidUpstreamBodyIsNotRepeated(t *testing.T) {
	calls := 0
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(400)
		w.Write([]byte(`{"message":"Invalid input","reason":"REQUEST_BODY_INVALID"}`))
	})
	rec := postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":2048,"messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != 400 || calls != 1 {
		t.Fatalf("code=%d calls=%d", rec.Code, calls)
	}
	if h.pool.GetNext() == nil {
		t.Fatal("invalid request cooled down the account")
	}
}

func TestNoLocalTruncationEvenWhenSmallLimitIsRequested(t *testing.T) {
	answer := strings.Repeat("COMPLETE_USER_VISIBLE_OUTPUT_", 100)
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": answer}), meteringFrame(t))
	})
	rec := postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}`)
	msg := decodeClaudeMessage(t, rec)
	blocks, _ := msg["content"].([]interface{})
	if len(blocks) != 1 || blocks[0].(map[string]interface{})["text"] != answer {
		t.Fatal("gateway changed or truncated the response")
	}
}

func TestSDKRequestIDOnErrors(t *testing.T) {
	h := newHandlerWithoutBackgroundForTest(t)
	r := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Header().Get("request-id") == "" || w.Header().Get("request-id") != w.Header().Get("x-request-id") {
		t.Fatal("SDK request ID missing")
	}
}
