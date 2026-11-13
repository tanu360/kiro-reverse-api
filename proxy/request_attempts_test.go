package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"kiro-proxy/config"
	"kiro-proxy/db"
	accountpool "kiro-proxy/pool"
)

// setRetryConfigForTest writes the retry settings into the stored config and
// reloads it. Call it before adding accounts: the reload replaces the config.
func setRetryConfigForTest(t *testing.T, maxPerAccount int) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	var raw string
	if err := d.QueryRow(`SELECT value FROM settings WHERE key = 'config'`).Scan(&raw); err != nil {
		t.Fatalf("read config: %v", err)
	}
	var stored map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	stored["maxRetriesPerAccount"] = maxPerAccount
	stored["retryBaseDelayMs"] = 1
	stored["retryMaxDelayMs"] = 1
	data, err := json.Marshal(stored)
	if err != nil {
		t.Fatalf("encode config: %v", err)
	}
	if _, err := d.Exec(`UPDATE settings SET value = ? WHERE key = 'config'`, string(data)); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := config.Load(); err != nil {
		t.Fatalf("reload config: %v", err)
	}
}

// attemptChainRun keeps account IDs unique per test: the pool is global and
// remembers each ID's cooldown across tests and -count runs.
var attemptChainRun atomic.Int32

// newAttemptChainHandler points the proxy at upstream with two accounts, one
// Kiro endpoint named "test" and no waits.
func newAttemptChainHandler(t *testing.T, maxPerAccount int, upstream http.HandlerFunc) *Handler {
	t.Helper()
	dir := tempDataDir(t)
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	setRetryConfigForTest(t, maxPerAccount)
	run := attemptChainRun.Add(1)
	for _, id := range []string{fmt.Sprintf("first-%d", run), fmt.Sprintf("second-%d", run)} {
		if err := config.AddAccount(config.Account{
			ID:          id,
			Email:       id + "@example.com",
			Enabled:     true,
			AccessToken: "token-" + id,
			ProfileArn:  "arn:aws:codewhisperer:profile/" + id,
		}); err != nil {
			t.Fatalf("add account %s: %v", id, err)
		}
	}
	if err := config.UpdatePreferredEndpoint("kiro"); err != nil {
		t.Fatalf("set preferred endpoint: %v", err)
	}
	if err := config.UpdateEndpointFallback(false); err != nil {
		t.Fatalf("disable endpoint fallback: %v", err)
	}

	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)

	oldEndpoints := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{{URL: server.URL, Origin: "AI_EDITOR", Name: "test"}}
	t.Cleanup(func() { kiroEndpoints = oldEndpoints })

	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}})
	t.Cleanup(func() { kiroHttpStore.Store(oldClient) })

	oldWait := streamRetryWait
	streamRetryWait = func(context.Context, time.Duration) error { return nil }
	t.Cleanup(func() { streamRetryWait = oldWait })

	p := accountpool.GetPool()
	p.Reload()
	return &Handler{pool: p, promptCache: newPromptCacheTracker(defaultPromptCacheTTL)}
}

// failingUpstream answers 500 for every call with the first account it sees
// (the pool's pick order is not fixed across tests) and a short answer
// otherwise. calls records the account behind each call, in order.
func failingUpstream(t *testing.T, calls *[]string) http.HandlerFunc {
	var failing string
	return func(w http.ResponseWriter, r *http.Request) {
		account := strings.TrimPrefix(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "token-")
		*calls = append(*calls, account)
		if failing == "" {
			failing = account
		}
		if account == failing {
			http.Error(w, "temporary upstream failure", http.StatusInternalServerError)
			return
		}
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answered"}),
			meteringFrame(t),
		)
	}
}

func lastRecordedAttempts(t *testing.T) []requestAttempt {
	t.Helper()
	recs := getObserveStore().RecentRequests(1)
	if len(recs) != 1 {
		t.Fatalf("expected one recorded request, got %d", len(recs))
	}
	return recs[0].Attempts
}

func TestAttemptChainRecordsFailoverAcrossAccounts(t *testing.T) {
	var calls []string
	h := newAttemptChainHandler(t, 1, failingUpstream(t, &calls))

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), requestEndpointClaude)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected failover to succeed, status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(calls) != 2 || calls[0] == calls[1] {
		t.Fatalf("upstream calls = %v", calls)
	}
	bad, good := calls[0], calls[1]

	attempts := lastRecordedAttempts(t)
	if len(attempts) != 2 {
		t.Fatalf("expected 2 attempts, got %#v", attempts)
	}
	first, second := attempts[0], attempts[1]
	if first.AccountID != bad || first.Email != bad+"@example.com" || first.Endpoint != "test" {
		t.Fatalf("first attempt identity = %#v", first)
	}
	if first.Success || first.Status != http.StatusInternalServerError || first.ErrorType != "upstream" ||
		!first.Failover || first.MidStream || !strings.Contains(first.Message, "HTTP 500") {
		t.Fatalf("first attempt outcome = %#v", first)
	}
	if second.AccountID != good || second.Endpoint != "test" || !second.Success ||
		second.Failover || second.Status != 0 || second.ErrorType != "" || second.Message != "" {
		t.Fatalf("second attempt = %#v", second)
	}
	if second.StartMs < first.StartMs {
		t.Fatalf("attempts out of order: %d then %d", first.StartMs, second.StartMs)
	}

	//! The detail sheet reads the persisted page: the chain must survive the SQLite round trip.
	page := getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 10})
	if !page.Persistent || len(page.Requests) != 1 {
		t.Fatalf("expected one persisted row, got persistent=%v rows=%d", page.Persistent, len(page.Requests))
	}
	if !reflect.DeepEqual(page.Requests[0].Attempts, attempts) {
		t.Fatalf("persisted attempts = %#v, want %#v", page.Requests[0].Attempts, attempts)
	}
	loaded, err := loadRecentRequestsFromDB(1)
	if err != nil || len(loaded) != 1 || !reflect.DeepEqual(loaded[0].Attempts, attempts) {
		t.Fatalf("warm-up load = %#v, err %v", loaded, err)
	}
}

func TestAttemptChainSameAccountRetryIsNotFailover(t *testing.T) {
	var calls []string
	h := newAttemptChainHandler(t, 2, failingUpstream(t, &calls))

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), requestEndpointOpenAI)
	h.handleOpenAINonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected the second account to answer, status=%d body=%s", rec.Code, rec.Body.String())
	}
	attempts := lastRecordedAttempts(t)
	var accounts []string
	var failover []bool
	for _, a := range attempts {
		accounts = append(accounts, a.AccountID)
		failover = append(failover, a.Failover)
	}
	if len(calls) != 3 || calls[2] == calls[0] || !reflect.DeepEqual(accounts, calls) || accounts[1] != accounts[0] {
		t.Fatalf("attempt accounts = %v", accounts)
	}
	if !reflect.DeepEqual(failover, []bool{false, true, false}) {
		t.Fatalf("failover flags = %v", failover)
	}
	if attempts[0].Success || attempts[1].Success || !attempts[2].Success {
		t.Fatalf("attempt outcomes = %#v", attempts)
	}
}

func TestAttemptChainMidStreamFlag(t *testing.T) {
	const answer = "This answer is long enough to leave the stream buffer, and then it stops"
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": answer}))
	})

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), requestEndpointClaude)
	h.handleClaudeStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	if calls.Load() != 1 {
		t.Fatalf("output reached the client, so no retry; got %d calls", calls.Load())
	}
	attempts := lastRecordedAttempts(t)
	if len(attempts) != 1 {
		t.Fatalf("expected 1 attempt, got %#v", attempts)
	}
	a := attempts[0]
	if a.AccountID != "only" || a.Success || !a.MidStream || a.Failover || a.ErrorType != "stream" {
		t.Fatalf("mid-stream attempt = %#v", a)
	}
}

func TestAttemptChainClientDisconnectClosesOpenAttempt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "partial"}))
		w.(http.Flusher).Flush()
		//! The client goes away while upstream is still streaming.
		cancel()
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	})

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil).WithContext(ctx), requestEndpointClaude)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	recs := getObserveStore().RecentRequests(1)
	if len(recs) != 1 || recs[0].Status != clientClosedRequestStatus {
		t.Fatalf("expected one 499 request, got %#v", recs)
	}
	attempts := recs[0].Attempts
	if len(attempts) != 1 {
		t.Fatalf("expected 1 attempt, got %#v", attempts)
	}
	a := attempts[0]
	if a.Success || a.Status != clientClosedRequestStatus || a.ErrorType != "client_closed" || a.Message != clientDisconnectedMessage {
		t.Fatalf("disconnected attempt = %#v", a)
	}
}

func traceContextForTest() (context.Context, *requestTrace) {
	trace := &requestTrace{startedAt: time.Now(), endpoint: requestEndpointClaude}
	return context.WithValue(context.Background(), requestTraceKey{}, trace), trace
}

func TestAttemptChainCapsAttemptsAndMessage(t *testing.T) {
	ctx, trace := traceContextForTest()
	long := strings.Repeat("é", 150) // 300 bytes of two-byte characters
	const total = 15
	for i := 0; i < total; i++ {
		account := &config.Account{ID: fmt.Sprintf("acc-%02d", i)}
		traceAttemptStart(ctx, account, "")
		if i < total-1 {
			traceAttemptFailed(ctx, account, 0, errors.New(long))
		}
	}
	attempts := trace.finishAttempts(true, http.StatusOK, "")

	if len(attempts) != maxRequestAttempts {
		t.Fatalf("expected %d attempts, got %d", maxRequestAttempts, len(attempts))
	}
	for i := 0; i < maxRequestAttempts-1; i++ {
		if want := fmt.Sprintf("acc-%02d", i); attempts[i].AccountID != want {
			t.Fatalf("attempt %d = %s, want %s", i, attempts[i].AccountID, want)
		}
		if attempts[i].Skipped != 0 || !attempts[i].Failover {
			t.Fatalf("attempt %d = %#v", i, attempts[i])
		}
		msg := attempts[i].Message
		if len(msg) > maxAttemptMessageBytes || !utf8.ValidString(msg) || !strings.HasPrefix(long, msg) || msg == "" {
			t.Fatalf("attempt %d message cut wrong: %d bytes, valid %v", i, len(msg), utf8.ValidString(msg))
		}
	}
	last := attempts[maxRequestAttempts-1]
	if last.AccountID != "acc-14" || !last.Success || last.Skipped != total-maxRequestAttempts {
		t.Fatalf("last attempt = %#v", last)
	}

	//! Finishing again returns the frozen chain; late helper calls change nothing.
	traceAttemptStart(ctx, &config.Account{ID: "late"}, "")
	if again := trace.finishAttempts(false, 500, "late"); !reflect.DeepEqual(again, attempts) {
		t.Fatalf("finish is not idempotent: %#v", again)
	}
}

func TestAttemptChainWebSearchGiveUpIsNotFailover(t *testing.T) {
	ctx, trace := traceContextForTest()
	one, two := &config.Account{ID: "one"}, &config.Account{ID: "two"}

	traceAttemptStart(ctx, one, "")
	traceAttemptStart(ctx, one, attemptEndpointWebSearch) // the chat round finished
	traceAttemptFailed(ctx, one, 0, errors.New("mcp unavailable"))
	traceAttemptStart(ctx, two, attemptEndpointWebSearch)
	traceAttemptFailed(ctx, two, 0, errors.New("mcp unavailable"))
	traceAttemptStart(ctx, one, "") // the next chat round
	attempts := trace.finishAttempts(true, http.StatusOK, "")

	got := make([]bool, len(attempts))
	for i, a := range attempts {
		got[i] = a.Failover
	}
	if !reflect.DeepEqual(got, []bool{false, true, false, false}) {
		t.Fatalf("failover flags = %v (%#v)", got, attempts)
	}
	if !attempts[0].Success || attempts[1].Endpoint != attemptEndpointWebSearch {
		t.Fatalf("attempts = %#v", attempts)
	}
}

// attemptFlags lists one flag of every attempt, in order.
func attemptFlags(attempts []requestAttempt, flag func(requestAttempt) bool) []bool {
	out := make([]bool, len(attempts))
	for i, a := range attempts {
		out[i] = flag(a)
	}
	return out
}

func TestAttemptChainSearchGiveUpEndsItsJob(t *testing.T) {
	for _, tc := range []struct {
		name     string
		accounts []string
		failover []bool
		gaveUp   []bool
	}{
		// Query A fails on one and two and gives up; query B starts on one again.
		{"two accounts", []string{"one", "two"}, []bool{false, true, false, true, false, false}, []bool{false, false, true, false, true, false}},
		// A one-account pool: query B on the same account is not a retry of query A.
		{"one account", []string{"one"}, []bool{false, false, false, false}, []bool{false, true, true, false}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, trace := traceContextForTest()
			chat := &config.Account{ID: "one"}
			traceAttemptStart(ctx, chat, "")
			traceAttemptOK(ctx)
			for range 2 { // two queries, both down
				for _, id := range tc.accounts {
					account := &config.Account{ID: id}
					traceAttemptStart(ctx, account, attemptEndpointWebSearch)
					traceAttemptFailed(ctx, account, 0, errors.New("MCP HTTP 500: down"))
				}
				traceAttemptGiveUp(ctx)
			}
			traceAttemptStart(ctx, &config.Account{ID: tc.accounts[len(tc.accounts)-1]}, "")
			attempts := trace.finishAttempts(true, http.StatusOK, "")

			if got := attemptFlags(attempts, func(a requestAttempt) bool { return a.Failover }); !reflect.DeepEqual(got, tc.failover) {
				t.Fatalf("failover flags = %v, want %v (%#v)", got, tc.failover, attempts)
			}
			if got := attemptFlags(attempts, func(a requestAttempt) bool { return a.GaveUp }); !reflect.DeepEqual(got, tc.gaveUp) {
				t.Fatalf("gaveUp flags = %v, want %v (%#v)", got, tc.gaveUp, attempts)
			}
		})
	}

	//! Giving up with no attempt of its own leaves a finished success alone.
	ctx, trace := traceContextForTest()
	traceAttemptStart(ctx, &config.Account{ID: "one"}, "")
	traceAttemptOK(ctx)
	traceAttemptGiveUp(ctx)
	if attempts := trace.finishAttempts(true, http.StatusOK, ""); len(attempts) != 1 || !attempts[0].Success || attempts[0].GaveUp {
		t.Fatalf("attempts = %#v", attempts)
	}
}

func TestAttemptChainFinishedAttemptKeepsItsSuccess(t *testing.T) {
	ctx, trace := traceContextForTest()
	account := &config.Account{ID: "one"}
	traceAttemptStart(ctx, account, "")
	traceAttemptOK(ctx) // the buffered chat round
	traceAttemptStart(ctx, account, attemptEndpointWebSearch)
	traceAttemptOK(ctx) // the search found results
	//! The next round finds no account, so no attempt starts before the final record.
	attempts := trace.finishAttempts(false, http.StatusServiceUnavailable, "no available accounts")

	if len(attempts) != 2 {
		t.Fatalf("expected 2 attempts, got %#v", attempts)
	}
	for i, a := range attempts {
		if !a.Success || a.Status != 0 || a.ErrorType != "" || a.Message != "" {
			t.Fatalf("attempt %d took the request's failure: %#v", i, a)
		}
	}
}

func TestAttemptChainWebSearchLoopQueriesGiveUpSeparately(t *testing.T) {
	var rounds atomic.Int32
	h := newAttemptChainHandler(t, 1, func(w http.ResponseWriter, _ *http.Request) {
		if rounds.Add(1) == 1 {
			writeFrames(w, webSearchToolUseFrame(t, "toolu_ws_a", "query a"), webSearchToolUseFrame(t, "toolu_ws_b", "query b"), meteringFrame(t))
			return
		}
		writeKiroTextResponse(t, w, "Search is down.")
	})
	stub := stubMCPWebSearch(t, http.StatusInternalServerError, "down")

	decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"latest go?"}]}`))
	if rounds.Load() != 2 || stub.calls.Load() != 4 {
		t.Fatalf("model rounds=%d MCP calls=%d", rounds.Load(), stub.calls.Load())
	}

	attempts := lastRecordedAttempts(t)
	endpoints := make([]string, len(attempts))
	for i, a := range attempts {
		endpoints[i] = a.Endpoint
	}
	ws := attemptEndpointWebSearch
	if !reflect.DeepEqual(endpoints, []string{"test", ws, ws, ws, ws, "test"}) {
		t.Fatalf("endpoints = %v", endpoints)
	}
	if got := attemptFlags(attempts, func(a requestAttempt) bool { return a.Success }); !reflect.DeepEqual(got, []bool{true, false, false, false, false, true}) {
		t.Fatalf("success flags = %v (%#v)", got, attempts)
	}
	//! Each query fails over once, then gives up; the next query is not its failover.
	if got := attemptFlags(attempts, func(a requestAttempt) bool { return a.Failover }); !reflect.DeepEqual(got, []bool{false, true, false, true, false, false}) {
		t.Fatalf("failover flags = %v (%#v)", got, attempts)
	}
	if got := attemptFlags(attempts, func(a requestAttempt) bool { return a.GaveUp }); !reflect.DeepEqual(got, []bool{false, false, true, false, true, false}) {
		t.Fatalf("gaveUp flags = %v (%#v)", got, attempts)
	}
	if attempts[1].AccountID == attempts[2].AccountID || attempts[3].AccountID == attempts[4].AccountID {
		t.Fatalf("each query must try both accounts: %#v", attempts)
	}
}

func TestAttemptChainJSONRoundTrip(t *testing.T) {
	attempts := []requestAttempt{
		{AccountID: "a1", Email: "a1@example.com", Endpoint: "Kiro IDE", StartMs: 0, DurationMs: 812, Status: 500,
			ErrorType: "upstream", Message: "HTTP 500 from Kiro IDE: boom", Failover: true},
		{AccountID: "a2", Endpoint: "Kiro IDE", StartMs: 830, DurationMs: 2104, Success: true, Skipped: 3},
	}
	raw := encodeAttempts(attempts)
	if !reflect.DeepEqual(decodeAttempts(raw), attempts) {
		t.Fatalf("round trip changed the chain: %s", raw)
	}
	//! Zero fields stay out of the stored JSON.
	if strings.Contains(raw, `"midStream"`) || strings.Contains(raw, `"email":""`) {
		t.Fatalf("encoded JSON is not compact: %s", raw)
	}
	if encodeAttempts(nil) != "" {
		t.Fatalf("no attempts must store an empty string")
	}
	for _, bad := range []string{"", "{not json", "[]", "null", `{"accountId":"x"}`} {
		if got := decodeAttempts(bad); got != nil {
			t.Fatalf("decodeAttempts(%q) = %#v, want nil", bad, got)
		}
	}
}

func TestAttemptChainNilTraceIsNoop(t *testing.T) {
	ctx := context.Background()
	account := &config.Account{ID: "x"}
	traceAttemptStart(ctx, account, "")
	noteAttemptEndpoint(ctx, "Kiro IDE")
	noteAttemptOutput(ctx, true)
	traceAttemptFailed(ctx, account, 0, errors.New("boom"))
	var trace *requestTrace
	if got := trace.finishAttempts(false, 500, "boom"); got != nil {
		t.Fatalf("nil trace returned %#v", got)
	}

	//! A request that never reached an attempt stores no chain at all.
	s := newObserveStoreForTest(t)
	early, _ := traceContextForTest()
	s.RecordTracedRequest(requestTraceFromContext(early), "", "", "", "", "m", 0, 0, 0, false, 400, "Invalid JSON")
	if got := s.RecentRequests(1); len(got) != 1 || got[0].Attempts != nil {
		t.Fatalf("early failure recorded attempts: %#v", got)
	}
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := d.QueryRow(`SELECT attempts_json FROM requests ORDER BY id DESC LIMIT 1`).Scan(&stored); err != nil || stored != "" {
		t.Fatalf("attempts_json = %q, err %v", stored, err)
	}
}

func TestUpstreamHTTPStatus(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"nil", nil, 0},
		{"client error", &upstreamClientError{status: 400, message: "HTTP 400 from test: bad"}, 400},
		{"quota", &upstreamQuotaError{message: "HTTP 429 from test: slow down"}, 429},
		{"wrapped quota", fmt.Errorf("call: %w", &upstreamQuotaError{message: "x"}), 429},
		{"kiro 5xx", errors.New("HTTP 503 from Kiro IDE: unavailable"), 503},
		{"refresh", errors.New("token refresh failed: HTTP 401: unauthorized"), 401},
		{"second match", errors.New("HTTP 5000 then HTTP 502"), 502},
		{"network", errors.New("dial tcp 127.0.0.1:9: connect: connection refused"), 0},
		{"protocol name", errors.New("malformed HTTP response"), 0},
	}
	for _, tc := range cases {
		if got := upstreamHTTPStatus(tc.err); got != tc.want {
			t.Errorf("%s: upstreamHTTPStatus = %d, want %d", tc.name, got, tc.want)
		}
	}
}
