package proxy

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const invalidModelBody = `{"message":"Invalid model ID. Please select a different model to continue.","reason":"INVALID_MODEL_ID"}`

// refusingUpstream answers 400 INVALID_MODEL_ID for every call with the first account it sees
// (the pick order is not fixed across tests), or for every account with refuseAll, and a
// short answer otherwise. calls records the account behind each call.
func refusingUpstream(t *testing.T, calls *[]string, refuseAll bool) http.HandlerFunc {
	var refusing string
	return func(w http.ResponseWriter, r *http.Request) {
		account := strings.TrimPrefix(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "token-")
		*calls = append(*calls, account)
		if refusing == "" {
			refusing = account
		}
		if refuseAll || account == refusing {
			http.Error(w, invalidModelBody, http.StatusBadRequest)
			return
		}
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answered"}),
			meteringFrame(t),
		)
	}
}

func TestEndsFailover(t *testing.T) {
	refusal := &upstreamClientError{status: 400, message: "HTTP 400 from AmazonQ: " + invalidModelBody}
	if endsFailover(refusal) || !isModelRefusal(refusal) {
		t.Fatal("an INVALID_MODEL_ID refusal ended the failover")
	}
	tooLong := &upstreamClientError{status: 400, message: `HTTP 400 from Kiro IDE: {"message":"Input is too long.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}`}
	if !endsFailover(tooLong) || isModelRefusal(tooLong) {
		t.Fatal("a request every account would refuse did not end the failover")
	}
	if endsFailover(errors.New("HTTP 500: INVALID_MODEL_ID")) || endsFailover(nil) {
		t.Fatal("an error that is no client error ended the failover")
	}
}

// Kiro refused the model for one account (its model list unknown, so the pool let the model
// through): the request moves on to another account instead of answering 400, and the next
// request for that model skips the refusing account.
func TestModelRefusalFailsOverAndIsRemembered(t *testing.T) {
	var calls []string
	h := newAttemptChainHandler(t, 3, refusingUpstream(t, &calls, false))

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), requestEndpointClaude)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want the other account to answer; body %s", rec.Code, rec.Body.String())
	}
	//! One call to the refusing account: a refusal is never retried on the same account.
	if len(calls) != 2 || calls[0] == calls[1] {
		t.Fatalf("upstream calls = %v, want the refusing account once, then the other", calls)
	}
	refusing, serving := calls[0], calls[1]
	if attempts := lastRecordedAttempts(t); len(attempts) != 2 || !attempts[0].Failover || attempts[0].Status != http.StatusBadRequest {
		t.Fatalf("attempts = %#v, want a failed-over 400 then a success", attempts)
	}
	if until := h.pool.CooldownUntil(refusing); !until.IsZero() {
		t.Fatalf("the refusing account cools down until %v; it serves other models", until)
	}

	calls = nil
	rec = httptest.NewRecorder()
	h.handleOpenAINonStream(rec, withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), requestEndpointOpenAI), testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)
	if rec.Code != http.StatusOK || len(calls) != 1 || calls[0] != serving {
		t.Fatalf("next request: status %d calls %v, want only %s", rec.Code, calls, serving)
	}
	if acc := h.pool.GetPreferredForModelExcluding(refusing, "claude-haiku-4.5", nil); acc == nil || acc.ID != refusing {
		t.Fatalf("pick for another model = %v, want the refusing account, which only lacks claude-sonnet-4.5", acc)
	}
}

// When every account refuses the model, the client gets Kiro's 400, after one call per account.
func TestModelRefusalByEveryAccountAnswers400(t *testing.T) {
	var calls []string
	h := newAttemptChainHandler(t, 3, refusingUpstream(t, &calls, true))

	rec := httptest.NewRecorder()
	h.handleOpenAINonStream(rec, withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), requestEndpointOpenAI), testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid model ID") {
		t.Fatalf("status %d body %s, want Kiro's 400", rec.Code, rec.Body.String())
	}
	if len(calls) != 2 || calls[0] == calls[1] {
		t.Fatalf("upstream calls = %v, want each account once", calls)
	}
}
