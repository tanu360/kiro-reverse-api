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
	attempts  attemptChain
	requestID string

	// conversationID is the session affinity key of the request's payload.
	conversationID string
	// body is the client's request body, kept for replay when it is small enough;
	// bodySize is its length either way. headers are the replayHeaders it sent.
	body     []byte
	bodySize int
	headers  map[string]string
	// replayOf is the logged request an admin replayed to make this one.
	replayOf int64
	// loggedID is the id of this request's log row once it is written.
	loggedID int64
}

type requestTraceKey struct{}

func withRequestTrace(r *http.Request, endpoint string) *http.Request {
	//! The clock starts before auth, so the logged duration is what the client waited.
	trace := &requestTrace{startedAt: time.Now(), endpoint: endpoint, requestID: requestIDFromContext(r.Context())}
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

func (t *requestTrace) conversation() string {
	if t == nil {
		return ""
	}
	return t.conversationID
}

func (t *requestTrace) replayOfID() int64 {
	if t == nil {
		return 0
	}
	return t.replayOf
}

// requestIDValue is the id the client got in {request_id}, so a log row can be found from it.
func (t *requestTrace) requestIDValue() string {
	if t == nil {
		return ""
	}
	return t.requestID
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
	case status == http.StatusTooManyRequests && strings.Contains(lower, "limit exceeded"),
		status == http.StatusTooManyRequests && strings.Contains(lower, "api key call limit"):
		return "api_key_limit"
	case isOverageErrorMessage(message):
		return "overage"
	case isQuotaErrorMessage(message):
		return "quota"
	case isSuspensionErrorMessage(message):
		return "suspended"
	case isProfileUnavailableErrorMessage(message):
		return "profile"
	//! Before auth: a proxy's own "authentication failed" or "Forbidden" says nothing about the token.
	case isProxyFailureMessage(message):
		return errorTypeProxy
	case isAuthErrorMessage(message), status == http.StatusUnauthorized:
		return "auth"
	case strings.Contains(lower, "upstream stream ended"),
		strings.Contains(lower, "upstream truncated response"),
		strings.Contains(lower, "upstream event stream"):
		return "stream"
	case strings.Contains(lower, "no available accounts"):
		return "no_accounts"
	case status == http.StatusBadRequest, status == http.StatusNotFound, status == http.StatusMethodNotAllowed:
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
