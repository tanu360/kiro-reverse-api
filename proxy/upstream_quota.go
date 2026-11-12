package proxy

import (
	"errors"
	"kiro-proxy/proxypool"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type upstreamClientError struct {
	status  int
	message string
}

func (e *upstreamClientError) Error() string { return e.message }
func isUpstreamClientError(err error) bool   { var e *upstreamClientError; return errors.As(err, &e) }
func isClientHTTPStatus(status int) bool {
	return status >= 400 && status < 500 && status != 401 && status != 402 && status != 403 && status != 429
}

type upstreamQuotaError struct {
	message  string
	retryFor time.Duration
	//! throttled marks a transient rate limit; only real usage exhaustion benches an account for days.
	throttled bool
}

func (e *upstreamQuotaError) Error() string { return e.message }

func (e *upstreamQuotaError) merge(next *upstreamQuotaError) *upstreamQuotaError {
	//! Quota is account-wide: one endpoint reporting exhaustion outweighs another's throttle.
	if e == nil {
		return next
	}
	if next.retryFor > e.retryFor || (e.throttled && !next.throttled) {
		e.message = next.message
	}
	e.retryFor = max(e.retryFor, next.retryFor)
	e.throttled = e.throttled && next.throttled
	return e
}

func isUsageQuotaExhaustedMessage(msg string) bool {
	//! Kiro reports spent monthly usage as reason MONTHLY_REQUEST_COUNT; ThrottlingException,
	//! INSUFFICIENT_MODEL_CAPACITY and unknown 429s are transient and must not cost days.
	msg = strings.ToLower(msg)
	for _, marker := range []string{
		"monthly",
		"usage limit",
		"quota exhausted",
		"quota exceeded",
		"quota reached",
		"insufficient_quota",
		"exceeded your current quota",
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

func retryAfterDuration(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	const limit = time.Hour
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds <= 0 {
			return 0
		}
		if seconds >= int64(limit/time.Second) {
			return limit
		}
		return time.Duration(seconds) * time.Second
	}
	if date, err := http.ParseTime(value); err == nil {
		delay := date.Sub(now)
		if delay <= 0 {
			return 0
		}
		if delay > limit {
			return limit
		}
		return delay
	}
	return 0
}

func upstreamFailureStatus(err error) int {
	var client *upstreamClientError
	if errors.As(err, &client) {
		return client.status
	}
	var quota *upstreamQuotaError
	if errors.As(err, &quota) {
		return http.StatusTooManyRequests
	}
	//! The outbound route is down, not the server: a client may retry once a proxy recovers.
	if proxypool.IsProxyError(err) {
		return http.StatusServiceUnavailable
	}
	return http.StatusInternalServerError
}

func setUpstreamRetryAfter(w http.ResponseWriter, err error) {
	var quota *upstreamQuotaError
	if errors.As(err, &quota) && quota.retryFor > 0 {
		//! Duration division yields a Duration; int64 strips the unit so the header is bare seconds per RFC 9110.
		seconds := int64((quota.retryFor + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	}
}

func (h *Handler) sendClaudeUpstreamError(w http.ResponseWriter, err error) {
	setUpstreamRetryAfter(w, err)
	kind := "api_error"
	if isUpstreamClientError(err) {
		kind = "invalid_request_error"
	}
	if upstreamFailureStatus(err) == 429 {
		kind = "rate_limit_error"
	}
	h.sendClaudeError(w, upstreamFailureStatus(err), kind, err.Error())
}

func (h *Handler) sendOpenAIUpstreamError(w http.ResponseWriter, err error) {
	setUpstreamRetryAfter(w, err)
	kind := "server_error"
	if isUpstreamClientError(err) {
		kind = "invalid_request_error"
	}
	if upstreamFailureStatus(err) == 429 {
		kind = "rate_limit_error"
	}
	h.sendOpenAIError(w, upstreamFailureStatus(err), kind, err.Error())
}
