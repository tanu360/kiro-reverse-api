package proxy

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type upstreamQuotaError struct {
	message  string
	retryFor time.Duration
}

func (e *upstreamQuotaError) Error() string { return e.message }

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
	var quota *upstreamQuotaError
	if errors.As(err, &quota) {
		return http.StatusTooManyRequests
	}
	return http.StatusInternalServerError
}

func setUpstreamRetryAfter(w http.ResponseWriter, err error) {
	var quota *upstreamQuotaError
	if errors.As(err, &quota) && quota.retryFor > 0 {
		w.Header().Set("Retry-After", fmt.Sprint((quota.retryFor+time.Second-1)/time.Second))
	}
}

func (h *Handler) sendClaudeUpstreamError(w http.ResponseWriter, err error) {
	setUpstreamRetryAfter(w, err)
	kind := "api_error"
	if upstreamFailureStatus(err) == 429 {
		kind = "rate_limit_error"
	}
	h.sendClaudeError(w, upstreamFailureStatus(err), kind, err.Error())
}

func (h *Handler) sendOpenAIUpstreamError(w http.ResponseWriter, err error) {
	setUpstreamRetryAfter(w, err)
	kind := "server_error"
	if upstreamFailureStatus(err) == 429 {
		kind = "rate_limit_error"
	}
	h.sendOpenAIError(w, upstreamFailureStatus(err), kind, err.Error())
}
