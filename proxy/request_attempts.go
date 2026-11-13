package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"kiro-proxy/config"
)

const (
	// maxRequestAttempts caps the chain kept on one request row: the first
	// attempts plus the latest, with the count of the ones dropped between.
	maxRequestAttempts = 10
	// maxAttemptMessageBytes caps each failed attempt's error text.
	maxAttemptMessageBytes = 200
	// attemptEndpointWebSearch names an MCP web search attempt, which never
	// goes through a Kiro chat endpoint.
	attemptEndpointWebSearch = "web_search"
)

// requestAttempt is one upstream try of a client request, as stored in
// requests.attempts_json and sent in the request log API. StartMs is the
// offset from the moment the request arrived.
type requestAttempt struct {
	AccountID  string `json:"accountId"`
	Email      string `json:"email,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	StartMs    int64  `json:"startMs"`
	DurationMs int64  `json:"durationMs"`
	Success    bool   `json:"success"`
	Status     int    `json:"status,omitempty"`
	ErrorType  string `json:"errorType,omitempty"`
	Message    string `json:"message,omitempty"`
	// Proxy names a failure at the outbound proxy (ErrorType "proxy"); Message then
	// holds the fixed wording clients get, and Go's text stays in the server log.
	Proxy *attemptProxyFailure `json:"proxy,omitempty"`
	// Failover marks a failed attempt that the next one moved to another account.
	Failover bool `json:"failover,omitempty"`
	// MidStream marks a failed attempt whose upstream stream had already sent output.
	MidStream bool `json:"midStream,omitempty"`
	// GaveUp marks the last failed attempt of a job that stopped trying (one web
	// search query, for example). The attempt after it starts other work, so it
	// is neither a failover nor a retry of this one.
	GaveUp bool `json:"gaveUp,omitempty"`
	// Skipped is set on the last attempt only: attempts dropped before it by the cap.
	Skipped int `json:"skipped,omitempty"`
}

// attemptChain collects a request's attempts in order. At most one attempt is
// open; the next start, a failure or the final record closes it. The zero
// value is ready to use.
type attemptChain struct {
	mu      sync.Mutex
	items   []requestAttempt
	open    bool
	openAt  time.Time
	output  bool
	skipped int
	done    bool
	// lastProxyFail is the latest attempt that failed at its proxy, with Go's text for
	// that failure: the request's final record carries the same text when it ends on it.
	lastProxyFail *failedAtProxy
	// endpointErr is the open attempt's own endpoint error when the call returned another
	// endpoint's error (a merged 429, an earlier 400): closing with that one uses this instead.
	endpointErr *endpointOwnError
}

type endpointOwnError struct {
	// final is the text of the error the call returned.
	final string
	err   error
}

type failedAtProxy struct {
	raw     string
	message string
}

func attemptChainFromContext(ctx context.Context) (*requestTrace, *attemptChain) {
	trace := requestTraceFromContext(ctx)
	if trace == nil {
		return nil, nil
	}
	return trace, &trace.attempts
}

// traceAttemptStart opens a new attempt on account. An attempt still open
// ended without a recorded failure, so it closes as a success (a call site
// that never closed its finished attempt, for example).
func traceAttemptStart(ctx context.Context, account *config.Account, endpoint string) {
	trace, c := attemptChainFromContext(ctx)
	if c == nil {
		return
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done {
		return
	}
	if c.open {
		c.closeLocked(now, true, 0, "")
	}
	c.endpointErr = nil
	accountID, email := accountIdentity(account)
	next := requestAttempt{
		AccountID: accountID,
		Email:     email,
		Endpoint:  endpoint,
		StartMs:   offsetMs(trace.startedAt, now),
	}
	c.appendLocked(next)
	c.open = true
	c.openAt = now
	c.output = false
}

// traceAttemptFailed closes the open attempt as failed. Without an open
// attempt (a call site that never started one) it logs a zero-length one,
// so the failure still shows in the chain.
func traceAttemptFailed(ctx context.Context, account *config.Account, status int, err error) {
	trace, c := attemptChainFromContext(ctx)
	if c == nil || err == nil {
		return
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done {
		return
	}
	if !c.open {
		accountID, email := accountIdentity(account)
		c.appendLocked(requestAttempt{AccountID: accountID, Email: email, StartMs: offsetMs(trace.startedAt, now)})
		c.open = true
		c.openAt = now
		c.output = false
	}
	if own := c.endpointErr; own != nil && err.Error() == own.final {
		err, status = own.err, 0
	}
	if status == 0 {
		status = upstreamHTTPStatus(err)
	}
	failure, atProxy := proxyFailureOf(account, err)
	if !atProxy {
		c.closeLocked(now, false, status, err.Error())
		return
	}
	//! Go's text repeats Kiro's URL and the proxy's address; the request log keeps the client's wording.
	message := upstreamErrorText(err)
	c.closeLocked(now, false, status, message)
	last := &c.items[len(c.items)-1]
	last.ErrorType = errorTypeProxy
	last.Proxy = failure
	c.lastProxyFail = &failedAtProxy{raw: err.Error(), message: message}
}

// proxyFailureMessage is the request log's wording for a request that ended on a
// try that failed at its proxy: message is the final error's text, which is that
// try's error text when the request ended on it.
func (t *requestTrace) proxyFailureMessage(message string) (string, bool) {
	if t == nil {
		return "", false
	}
	c := &t.attempts
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastProxyFail == nil || c.lastProxyFail.raw != message {
		return "", false
	}
	return c.lastProxyFail.message, true
}

// traceAttemptOK closes the open attempt as a success. Call it where an
// attempt's work is complete before the request's final record (a buffered
// web search round, an MCP search), so a later failure that has nothing to do
// with it is not pinned on it.
func traceAttemptOK(ctx context.Context) {
	_, c := attemptChainFromContext(ctx)
	if c == nil {
		return
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open && !c.done {
		c.closeLocked(now, true, 0, "")
	}
}

// traceAttemptGiveUp marks the last attempt as the end of a job that gave up
// after it failed. The next attempt then starts new work and is not flagged
// as its failover.
func traceAttemptGiveUp(ctx context.Context) {
	_, c := attemptChainFromContext(ctx)
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open || c.done || len(c.items) == 0 {
		return
	}
	if last := &c.items[len(c.items)-1]; !last.Success {
		last.GaveUp = true
	}
}

// traceEndpointFallback runs when a Kiro endpoint failed and the same account tries the next
// one. The open attempt closes as failed with err and a new one opens on endpoint, so the
// request's attempt list shows every endpoint tried, not only the last.
func traceEndpointFallback(ctx context.Context, account *config.Account, endpoint string, err error) {
	_, c := attemptChainFromContext(ctx)
	if c == nil {
		return
	}
	c.mu.Lock()
	tried := err != nil && c.open && !c.done && len(c.items) > 0 && c.items[len(c.items)-1].Endpoint != ""
	c.mu.Unlock()
	if !tried {
		noteAttemptEndpoint(ctx, endpoint)
		return
	}
	traceAttemptFailed(ctx, account, 0, err)
	traceAttemptStart(ctx, account, endpoint)
}

// noteAttemptEndpoint records the Kiro endpoint the open attempt is calling.
func noteAttemptEndpoint(ctx context.Context, name string) {
	_, c := attemptChainFromContext(ctx)
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open && !c.done && len(c.items) > 0 {
		c.items[len(c.items)-1].Endpoint = name
		c.endpointErr = nil
	}
}

// noteAttemptEndpointError records own as the open attempt's error when the Kiro call
// returns final, another endpoint's error (a 429 merged across endpoints, for example).
// The caller closes the attempt with final; the attempt then shows own instead.
func noteAttemptEndpointError(ctx context.Context, own, final error) {
	_, c := attemptChainFromContext(ctx)
	if c == nil || own == nil || final == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open && !c.done {
		c.endpointErr = &endpointOwnError{final: final.Error(), err: own}
	}
}

// noteAttemptOutput records that the open attempt's upstream stream emitted
// output. It only ever sets the flag: an auto-continue call that fails before
// output does not undo the output of the call before it.
func noteAttemptOutput(ctx context.Context, emitted bool) {
	if !emitted {
		return
	}
	_, c := attemptChainFromContext(ctx)
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open && !c.done {
		c.output = true
	}
}

// finishAttempts closes any open attempt with the request's final outcome,
// freezes the chain and returns a copy of it (nil when nothing was tried).
// Later calls return the same chain.
func (t *requestTrace) finishAttempts(success bool, status int, message string) []requestAttempt {
	if t == nil {
		return nil
	}
	c := &t.attempts
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.done {
		if c.open {
			if own := c.endpointErr; own != nil && !success && message == own.final {
				status, message = upstreamHTTPStatus(own.err), upstreamErrorText(own.err)
			}
			c.closeLocked(time.Now(), success, status, message)
		}
		if c.skipped > 0 && len(c.items) > 0 {
			c.items[len(c.items)-1].Skipped = c.skipped
		}
		c.done = true
	}
	if len(c.items) == 0 {
		return nil
	}
	return append([]requestAttempt(nil), c.items...)
}

// appendLocked adds an attempt and marks the one before it as a failover when
// it failed, its job did not give up, and the new one runs on another account
// for the same kind of work. Past the cap, the newest
// kept attempt makes room: the chain keeps the first attempts and the latest.
func (c *attemptChain) appendLocked(next requestAttempt) {
	if n := len(c.items); n > 0 {
		prev := &c.items[n-1]
		//! A web search giving up and the next chat round are different jobs, not a failover.
		if !prev.Success && !prev.GaveUp && prev.AccountID != next.AccountID &&
			(prev.Endpoint == attemptEndpointWebSearch) == (next.Endpoint == attemptEndpointWebSearch) {
			prev.Failover = true
		}
	}
	if len(c.items) >= maxRequestAttempts {
		c.items = c.items[:maxRequestAttempts-1]
		c.skipped++
	}
	c.items = append(c.items, next)
}

func (c *attemptChain) closeLocked(now time.Time, success bool, status int, message string) {
	c.open = false
	c.endpointErr = nil
	if len(c.items) == 0 {
		return
	}
	a := &c.items[len(c.items)-1]
	a.DurationMs = max(now.Sub(c.openAt).Milliseconds(), 0)
	a.Success = success
	if success {
		return
	}
	a.Status = status
	a.ErrorType = classifyRequestError(false, status, message)
	a.Message = truncateUTF8(message, maxAttemptMessageBytes)
	a.MidStream = c.output
}

func offsetMs(start, now time.Time) int64 {
	if start.IsZero() {
		return 0
	}
	return max(now.Sub(start).Milliseconds(), 0)
}

// upstreamHTTPStatus is the HTTP status an attempt's error carries: Kiro's
// own 4xx, 429 for a quota or throttle, or the "HTTP NNN" in the message
// (token refresh and Kiro 5xx errors). 0 when there is none, such as a
// network failure.
func upstreamHTTPStatus(err error) int {
	if err == nil {
		return 0
	}
	var client *upstreamClientError
	if errors.As(err, &client) {
		return client.status
	}
	var quota *upstreamQuotaError
	if errors.As(err, &quota) {
		return http.StatusTooManyRequests
	}
	msg := err.Error()
	for i := 0; ; {
		idx := strings.Index(msg[i:], "HTTP ")
		if idx < 0 {
			return 0
		}
		start := i + idx + len("HTTP ")
		end := start
		for end < len(msg) && end-start < 4 && msg[end] >= '0' && msg[end] <= '9' {
			end++
		}
		if end-start == 3 {
			if code, convErr := strconv.Atoi(msg[start:end]); convErr == nil && code >= 100 && code <= 599 {
				return code
			}
		}
		i = start
	}
}

// truncateUTF8 cuts s to at most n bytes without splitting a character.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// encodeAttempts is the attempts_json column value: "" for no attempts.
func encodeAttempts(attempts []requestAttempt) string {
	if len(attempts) == 0 {
		return ""
	}
	data, err := json.Marshal(attempts)
	if err != nil {
		return ""
	}
	return string(data)
}

// decodeAttempts reads attempts_json back. A legacy or damaged value reads as
// no attempts rather than failing the whole page.
func decodeAttempts(raw string) []requestAttempt {
	if raw == "" {
		return nil
	}
	var attempts []requestAttempt
	if err := json.Unmarshal([]byte(raw), &attempts); err != nil || len(attempts) == 0 {
		return nil
	}
	return attempts
}
