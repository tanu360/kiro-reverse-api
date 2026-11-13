package proxy

import (
	"errors"
	"net/http"
	"strings"

	"kiro-proxy/config"
)

// shouldRetryHeader is read by the Anthropic and OpenAI SDKs, and by Claude Code, before
// their own status rules. Claude Code retries a 401 and a 429 up to 10 times over about
// 3 minutes; "false" makes it show the error at once.
const shouldRetryHeader = "X-Should-Retry"

// markNoRetry tells the client that sending the same request again gets the same answer.
func markNoRetry(w http.ResponseWriter) {
	w.Header().Set(shouldRetryHeader, "false")
}

// noRetryStatus reports the statuses whose answer only changes when the client changes
// the request or its key: bad requests, auth failures and models no account serves.
// 408, 409, 429 and 5xx stay retryable.
func noRetryStatus(status int) bool {
	switch status {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound,
		http.StatusMethodNotAllowed, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return true
	}
	return false
}

// markNoRetryForKeyLimit marks a key's own limit refusal as final: the call limit used up,
// or the token or credit limit. A call limit that counts calls still in progress may clear
// when one of them fails, so that refusal stays retryable.
func markNoRetryForKeyLimit(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	if errors.Is(err, config.ErrApiKeyCallLimitExceeded) && strings.Contains(err.Error(), "in progress") {
		return
	}
	markNoRetry(w)
}
