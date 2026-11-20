package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRetryAfterParsing(t *testing.T) {
	now := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	for value, want := range map[string]time.Duration{"120": 2 * time.Minute, "-1": 0, "bad": 0, "0": 0, "999999999999": time.Hour, now.Add(30 * time.Second).Format(http.TimeFormat): 30 * time.Second, now.Add(-time.Minute).Format(http.TimeFormat): 0} {
		if got := retryAfterDuration(value, now); got != want {
			t.Fatalf("%q = %v want %v", value, got, want)
		}
	}
}

func TestUpstreamQuotaPreservesStatusHintAndCooldown(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Retry-After", "120")
				http.Error(w, "rate limited", http.StatusTooManyRequests)
			})
			t.Cleanup(func() { h.pool.RecordSuccess("only") })
			logs := captureLogs(t)
			body := `{"model":"claude-sonnet-4.5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`
			if path == "/v1/responses" {
				body = `{"model":"claude-sonnet-4.5","input":"hi"}`
			}
			rec := httptest.NewRecorder()
			r := httptest.NewRequest("POST", path, strings.NewReader(body))
			switch path {
			case "/v1/messages":
				h.handleClaudeMessages(rec, r)
			case "/v1/responses":
				h.handleOpenAIResponses(rec, r)
			default:
				h.handleOpenAIChat(rec, r)
			}
			if rec.Code != 429 || rec.Header().Get("Retry-After") != "120" {
				t.Fatalf("status/hint %d %s: %s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
			}
			if h.pool.GetNext() != nil {
				t.Fatal("quota cooldown bypassed on next request")
			}
			if want := "(429, retry-after 2m), trying next"; !strings.Contains(logs.String(), want) {
				t.Fatalf("missing %q in logs:\n%s", want, logs)
			}
		})
	}
}

// Kiro's refusal of an input over the context window, as recorded live on both chat APIs.
func contextOverflowErrors(t *testing.T) map[string]error {
	t.Helper()
	body := []byte(`{"message":"Input content length exceeds threshold.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}`)
	return map[string]error{
		"generateAssistantResponse": &upstreamClientError{status: http.StatusBadRequest, message: "HTTP 400 from AmazonQ: " + string(body)},
		"CreateResponse":            responsesHTTPFailure(http.StatusRequestEntityTooLarge, http.Header{}, body, time.Now()),
	}
}

func TestContextOverflowReadsAsPromptTooLongForClaude(t *testing.T) {
	for name, err := range contextOverflowErrors(t) {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			(&Handler{}).sendClaudeUpstreamError(rec, err)
			var body struct {
				Error struct{ Type, Message string } `json:"error"`
			}
			if jsonErr := json.Unmarshal(rec.Body.Bytes(), &body); jsonErr != nil {
				t.Fatal(jsonErr)
			}
			if rec.Code != http.StatusBadRequest || body.Error.Type != "invalid_request_error" || !strings.HasPrefix(body.Error.Message, "prompt is too long: ") {
				t.Fatalf("status %d body %s, want a 400 invalid_request_error starting \"prompt is too long: \"", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestContextOverflowCarriesOpenAIsCode(t *testing.T) {
	for name, err := range contextOverflowErrors(t) {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			(&Handler{}).sendOpenAIUpstreamError(rec, err)
			var body struct {
				Error struct {
					Type string  `json:"type"`
					Code *string `json:"code"`
				} `json:"error"`
			}
			if jsonErr := json.Unmarshal(rec.Body.Bytes(), &body); jsonErr != nil {
				t.Fatal(jsonErr)
			}
			if rec.Code != http.StatusBadRequest || body.Error.Type != "invalid_request_error" || body.Error.Code == nil || *body.Error.Code != "context_length_exceeded" {
				t.Fatalf("status %d body %s, want 400 with code context_length_exceeded", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestOtherClientErrorsKeepTheirText(t *testing.T) {
	err := &upstreamClientError{status: http.StatusBadRequest, message: `HTTP 400 from Kiro IDE: {"message":"Improperly formed request.","reason":null}`}
	rec := httptest.NewRecorder()
	(&Handler{}).sendClaudeUpstreamError(rec, err)
	if strings.Contains(rec.Body.String(), "prompt is too long") {
		t.Fatalf("a malformed request is not an over-long prompt: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	(&Handler{}).sendOpenAIUpstreamError(rec, err)
	if strings.Contains(rec.Body.String(), "context_length_exceeded") {
		t.Fatalf("a malformed request is not over the context window: %s", rec.Body.String())
	}
}

// Kiro's throttle, as captured live: a 429 ThrottlingException that names no wait at all.
func TestThrottle429TellsTheClientTheCooldown(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("x-amzn-ErrorType", "ThrottlingException:http://internal.amazon.com/coral/com.amazon.coral.availability/")
				http.Error(w, `{"message":"Too many requests, please wait before trying again.","reason":"USER_REQUEST_RATE_EXCEEDED"}`, http.StatusTooManyRequests)
			})
			t.Cleanup(func() { h.pool.RecordSuccess("only") })
			body := `{"model":"claude-sonnet-4.5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`
			if path == "/v1/responses" {
				body = `{"model":"claude-sonnet-4.5","input":"hi"}`
			}
			rec := httptest.NewRecorder()
			w, r, finish := wrapClientResponse(rec, httptest.NewRequest("POST", path, strings.NewReader(body)))
			switch path {
			case "/v1/messages":
				h.handleClaudeMessages(w, r)
			case "/v1/responses":
				h.handleOpenAIResponses(w, r)
			default:
				h.handleOpenAIChat(w, r)
			}
			finish()
			if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "5" {
				t.Fatalf("status %d Retry-After %q, want 429 with the 5 s throttle cooldown: %s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
			}
		})
	}
}
