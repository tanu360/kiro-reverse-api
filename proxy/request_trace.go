package proxy

import (
	"context"
	"net/http"
	"strings"
	"time"
)

const (
	requestEndpointClaude    = "claude"
	requestEndpointOpenAI    = "openai"
	requestEndpointResponses = "responses"
)

type requestTrace struct {
	startedAt time.Time
	endpoint  string
}

type requestTraceKey struct{}

func withRequestTrace(r *http.Request, endpoint string) *http.Request {
	//! The clock starts before auth, so the logged duration is what the client waited.
	trace := &requestTrace{startedAt: time.Now(), endpoint: endpoint}
	return r.WithContext(context.WithValue(r.Context(), requestTraceKey{}, trace))
}

func requestTraceFromContext(ctx context.Context) *requestTrace {
	if ctx == nil {
		return nil
	}
	trace, _ := ctx.Value(requestTraceKey{}).(*requestTrace)
	return trace
}

func (t *requestTrace) durationMs() int64 {
	if t == nil || t.startedAt.IsZero() {
		return 0
	}
	return time.Since(t.startedAt).Milliseconds()
}

func (t *requestTrace) endpointName() string {
	if t == nil {
		return ""
	}
	return t.endpoint
}

func requestEndpointForPath(path string) string {
	switch path {
	case "/v1/messages", "/messages", "/anthropic/v1/messages":
		return requestEndpointClaude
	case "/v1/chat/completions", "/chat/completions":
		return requestEndpointOpenAI
	case "/v1/responses", "/responses":
		return requestEndpointResponses
	}
	return ""
}

func classifyRequestError(success bool, status int, message string) string {
	//! Account faults come first: their messages are specific, while statuses are often a generic 500.
	if success {
		return ""
	}
	lower := strings.ToLower(message)
	switch {
	case status == 499:
		return "client_closed"
	case status == http.StatusTooManyRequests && strings.Contains(lower, "limit exceeded"):
		return "api_key_limit"
	case isOverageErrorMessage(message):
		return "overage"
	case isQuotaErrorMessage(message):
		return "quota"
	case isSuspensionErrorMessage(message):
		return "suspended"
	case isProfileUnavailableErrorMessage(message):
		return "profile"
	case isAuthErrorMessage(message), status == http.StatusUnauthorized:
		return "auth"
	case strings.Contains(lower, "upstream stream ended"),
		strings.Contains(lower, "upstream truncated response"),
		strings.Contains(lower, "upstream event stream"):
		return "stream"
	case strings.Contains(lower, "no available accounts"):
		return "no_accounts"
	case status == http.StatusBadRequest, status == http.StatusMethodNotAllowed:
		return "invalid_request"
	case status == http.StatusTooManyRequests:
		return "rate_limit"
	case strings.Contains(lower, "timeout"), strings.Contains(lower, "deadline exceeded"):
		return "timeout"
	case status >= 500 || status == 0:
		return "upstream"
	default:
		return "unknown"
	}
}
