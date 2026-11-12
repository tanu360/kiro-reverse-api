package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
)

const boundKeyClaudeBody = `{"model":"claude-sonnet-4.5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`
const boundKeyOpenAIBody = `{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}`

// servedBy collects which account's token reached the fake upstream.
type servedBy struct {
	mu     sync.Mutex
	tokens []string
}

func (s *servedBy) add(token string) {
	s.mu.Lock()
	s.tokens = append(s.tokens, token)
	s.mu.Unlock()
}

func (s *servedBy) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.tokens...)
}

// newKeyAccessHandler points the proxy at upstream with the given accounts
// (token "token-<id>"; ids starting with "off-" are disabled), requires API
// keys and returns the handler.
func newKeyAccessHandler(t *testing.T, upstream http.HandlerFunc, accountIDs ...string) *Handler {
	t.Helper()
	resetObservePersistenceForTest(t)
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, id := range accountIDs {
		if err := config.AddAccount(config.Account{
			ID:          id,
			Email:       id + "@example.com",
			Enabled:     !strings.HasPrefix(id, "off-"),
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
	if upstream != nil {
		server := httptest.NewServer(upstream)
		t.Cleanup(server.Close)
		oldEndpoints := kiroEndpoints
		kiroEndpoints = []kiroEndpoint{{URL: server.URL, Origin: "AI_EDITOR", Name: "key-access-test"}}
		t.Cleanup(func() { kiroEndpoints = oldEndpoints })
		oldClient := kiroHttpStore.Load()
		kiroHttpStore.Store(&http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}})
		t.Cleanup(func() { kiroHttpStore.Store(oldClient) })
	}
	oldWait := streamRetryWait
	streamRetryWait = func(context.Context, time.Duration) error { return nil }
	t.Cleanup(func() { streamRetryWait = oldWait })

	p := accountpool.GetPool()
	p.Reload()
	for _, id := range accountIDs {
		p.RecordSuccess(id)
		p.SetModelList(id, nil)
	}
	return &Handler{pool: p, promptCache: newPromptCacheTracker(defaultPromptCacheTTL), affinity: newSessionAffinity()}
}

func requireKeys(t *testing.T) {
	t.Helper()
	on := true
	if err := config.UpdateSettingsPatch(&on, ""); err != nil {
		t.Fatalf("require api keys: %v", err)
	}
}

func addTestKey(t *testing.T, entry config.ApiKeyEntry) config.ApiKeyEntry {
	t.Helper()
	entry.Enabled = true
	created, err := config.AddApiKey(entry)
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	return created
}

func serveWithKey(h *Handler, method, path, key, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	var req *http.Request
	if reader != nil {
		req = httptest.NewRequest(method, path, reader)
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	h.ServeHTTP(rec, req)
	return rec
}

// adminRequestForTest is an admin API request with a fresh admin session.
func adminRequestForTest(t *testing.T, h *Handler, method, path string) *http.Request {
	t.Helper()
	if h.adminSessions == nil {
		h.adminSessions = newAdminSessionStore()
	}
	token, _, err := h.adminSessions.Issue()
	if err != nil {
		t.Fatalf("admin session: %v", err)
	}
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("X-Admin-Token", token)
	return req
}

func recordingUpstream(t *testing.T, served *servedBy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		served.add(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		writeKiroTextResponse(t, w, "hello")
	}
}

func TestPickAccountHonorsApiKeyAllowlist(t *testing.T) {
	h := affinityTestHandler(t, "bind-a", "bind-b", "bind-c")
	bound := config.ApiKeyEntry{ID: "k-bound", Key: "sk-bound", AccountIDs: []string{"bind-b", "bind-c"}}
	ctx := withApiKeyContext(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), &bound).Context()

	// The conversation was last served by an account this key may not use.
	conv := payloadFor("conversation-bound")
	h.affinity.Bind(affinityKey(conv), "bind-a")
	seen := map[string]bool{}
	for i := 0; i < 6; i++ {
		acc := h.pickAccount(ctx, payloadFor("conversation-"+string(rune('a'+i))), "", nil)
		if acc == nil {
			t.Fatalf("pick %d: nil", i)
		}
		seen[acc.ID] = true
	}
	if acc := h.pickAccount(ctx, conv, "", nil); acc == nil || acc.ID == "bind-a" {
		t.Fatalf("affinity sent a bound key to %v", acc)
	}
	if seen["bind-a"] || !seen["bind-b"] || !seen["bind-c"] {
		t.Fatalf("picked %v, want only bind-b and bind-c", seen)
	}

	// An unbound key and a request without a key still use the whole pool.
	unbound := config.ApiKeyEntry{ID: "k-open", Key: "sk-open"}
	open := withApiKeyContext(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), &unbound).Context()
	if acc := h.pickAccount(open, conv, "", nil); acc == nil || acc.ID != "bind-a" {
		t.Fatalf("unbound key with affinity: got %v, want bind-a", acc)
	}
	if acc := h.pickAccount(context.Background(), conv, "", nil); acc == nil || acc.ID != "bind-a" {
		t.Fatalf("no key with affinity: got %v, want bind-a", acc)
	}
}

// End to end: requests with a bound key reach only its accounts, on both APIs
// and both stream modes.
func TestBoundApiKeyRequestsReachOnlyBoundAccounts(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a", "free-b", "free-c")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-bound-e2e", AccountIDs: []string{"free-b"}})
	requireKeys(t)

	streamClaude := strings.Replace(boundKeyClaudeBody, `"max_tokens":64`, `"max_tokens":64,"stream":true`, 1)
	streamOpenAI := strings.Replace(boundKeyOpenAIBody, `"messages"`, `"stream":true,"messages"`, 1)
	for _, tc := range []struct{ path, body string }{
		{"/v1/messages", boundKeyClaudeBody},
		{"/v1/messages", streamClaude},
		{"/v1/chat/completions", boundKeyOpenAIBody},
		{"/v1/chat/completions", streamOpenAI},
	} {
		rec := serveWithKey(h, http.MethodPost, tc.path, key.Key, tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status=%d body=%s", tc.path, rec.Code, rec.Body.String())
		}
	}
	tokens := served.list()
	if len(tokens) != 4 {
		t.Fatalf("upstream calls = %v, want 4", tokens)
	}
	for _, token := range tokens {
		if token != "token-free-b" {
			t.Fatalf("a bound key reached %q, want only token-free-b (all: %v)", token, tokens)
		}
	}
	if got := config.GetApiKeyEntry(key.ID); got.SuccessfulCalls != 4 {
		t.Fatalf("successfulCalls = %d, want 4", got.SuccessfulCalls)
	}
}

func TestBoundApiKeyFailsWhenBoundAccountsUnavailable(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a", "off-b", "free-c")
	// Bound to a disabled account, and to one that does not list the model.
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-bound-off", AccountIDs: []string{"off-b", "free-c"}, CallLimit: 1})
	h.pool.SetModelList("free-c", []string{"claude-haiku-4.5"})
	requireKeys(t)

	for i := 0; i < 2; i++ {
		rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody)
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "No available accounts") {
			t.Fatalf("request %d: status=%d body=%s, want 503 No available accounts", i, rec.Code, rec.Body.String())
		}
	}
	rec := serveWithKey(h, http.MethodPost, "/v1/chat/completions", key.Key, boundKeyOpenAIBody)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "No available accounts") {
		t.Fatalf("openai: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if tokens := served.list(); len(tokens) != 0 {
		t.Fatalf("a bound key spilled over to %v", tokens)
	}
	// The failures freed their call slot each time (the second request got a 503, not a 429).
	if got := config.GetApiKeyEntry(key.ID); got.SuccessfulCalls != 0 {
		t.Fatalf("failed calls counted: successfulCalls = %d", got.SuccessfulCalls)
	}
}

func modelIDs(t *testing.T, rec *httptest.ResponseRecorder) map[string]bool {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			Slug string `json:"slug"`
		} `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ids := map[string]bool{}
	for _, m := range body.Data {
		ids[m.ID] = true
	}
	for _, m := range body.Models {
		ids[m.Slug] = true
	}
	return ids
}

// modelTestHandler has free-a (haiku and opus) and free-b (haiku only) and a
// cached model list, so /v1/models never sweeps upstream.
func modelTestHandler(t *testing.T) *Handler {
	t.Helper()
	h := newKeyAccessHandler(t, nil, "free-a", "free-b")
	h.pool.SetModelList("free-a", []string{"claude-haiku-4.5", "claude-opus-4.5"})
	h.pool.SetModelList("free-b", []string{"claude-haiku-4.5"})
	h.cachedModels = []ModelInfo{
		{ModelId: "claude-haiku-4.5", ModelName: "Claude Haiku 4.5"},
		{ModelId: "claude-opus-4.5", ModelName: "Claude Opus 4.5"},
	}
	return h
}

func TestModelsEndpointFiltersForBoundApiKey(t *testing.T) {
	h := modelTestHandler(t)
	bound := addTestKey(t, config.ApiKeyEntry{Key: "sk-models-bound", AccountIDs: []string{"free-b"}})
	open := addTestKey(t, config.ApiKeyEntry{Key: "sk-models-open"})
	gone := addTestKey(t, config.ApiKeyEntry{Key: "sk-models-gone", AccountIDs: []string{"free-a"}})
	if err := config.DeleteAccount("free-a"); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	h.pool.Reload()
	requireKeys(t)

	ids := modelIDs(t, serveWithKey(h, http.MethodGet, "/v1/models", bound.Key, ""))
	if !ids["claude-haiku-4.5"] || !ids["claude-haiku-4.5-thinking"] || !ids["auto"] {
		t.Fatalf("bound key lost models it can use: %v", ids)
	}
	if ids["claude-opus-4.5"] || ids["claude-opus-4.5-thinking"] {
		t.Fatalf("bound key lists a model only other accounts serve: %v", ids)
	}

	// The unbound key still lists what the rest of the pool serves.
	ids = modelIDs(t, serveWithKey(h, http.MethodGet, "/v1/models", open.Key, ""))
	if !ids["claude-haiku-4.5"] {
		t.Fatalf("unbound key: %v", ids)
	}

	// A key bound only to a deleted account lists nothing but auto.
	ids = modelIDs(t, serveWithKey(h, http.MethodGet, "/v1/models", gone.Key, ""))
	if len(ids) != 1 || !ids["auto"] {
		t.Fatalf("key bound to a deleted account lists %v, want only auto", ids)
	}
}

func TestModelsEndpointUnboundKeyListsWholePool(t *testing.T) {
	h := modelTestHandler(t)
	open := addTestKey(t, config.ApiKeyEntry{Key: "sk-models-open"})
	requireKeys(t)
	ids := modelIDs(t, serveWithKey(h, http.MethodGet, "/v1/models", open.Key, ""))
	if !ids["claude-opus-4.5"] || !ids["claude-haiku-4.5"] {
		t.Fatalf("unbound key lost models: %v", ids)
	}
}

func TestCodexModelsEndpointFiltersForBoundApiKey(t *testing.T) {
	h := modelTestHandler(t)
	bound := addTestKey(t, config.ApiKeyEntry{Key: "sk-codex-bound", AccountIDs: []string{"free-b"}})
	open := addTestKey(t, config.ApiKeyEntry{Key: "sk-codex-open"})
	requireKeys(t)

	ids := modelIDs(t, serveWithKey(h, http.MethodGet, "/v1/codex/models", bound.Key, ""))
	if !ids["claude-haiku-4.5"] || ids["claude-opus-4.5"] {
		t.Fatalf("bound key codex models = %v, want haiku and no opus", ids)
	}
	ids = modelIDs(t, serveWithKey(h, http.MethodGet, "/v1/codex/models", open.Key, ""))
	if !ids["claude-haiku-4.5"] || !ids["claude-opus-4.5"] {
		t.Fatalf("unbound key codex models = %v", ids)
	}
}

func TestRegenerateApiKeyInvalidatesOldValue(t *testing.T) {
	h := modelTestHandler(t)
	key := addTestKey(t, config.ApiKeyEntry{Name: "laptop", Key: "sk-before-regenerate", CallLimit: 5, AccountIDs: []string{"free-b"}})
	if err := config.RecordApiKeyUsage(key.ID, 10, 0); err != nil {
		t.Fatalf("record usage: %v", err)
	}
	requireKeys(t)
	if rec := serveWithKey(h, http.MethodGet, "/v1/models", key.Key, ""); rec.Code != http.StatusOK {
		t.Fatalf("old value before regenerate: %d", rec.Code)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminRequestForTest(t, h, http.MethodPost, "/admin/api/api-keys/"+key.ID+"/regenerate"))
	if rec.Code != http.StatusOK {
		t.Fatalf("regenerate: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Success bool       `json:"success"`
		ID      string     `json:"id"`
		Key     string     `json:"key"`
		APIKey  apiKeyView `json:"apiKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Success || body.ID != key.ID || !strings.HasPrefix(body.Key, "sk-") || body.Key == key.Key {
		t.Fatalf("regenerate body = %+v", body)
	}
	if body.APIKey.Key != "" || body.APIKey.KeyMasked != config.MaskApiKey(body.Key) {
		t.Fatalf("view leaks or mismasks the key: %+v", body.APIKey)
	}
	if body.APIKey.Name != "laptop" || body.APIKey.CallLimit != 5 || body.APIKey.SuccessfulCalls != 1 || body.APIKey.TokensUsed != 10 {
		t.Fatalf("regenerate lost settings or usage: %+v", body.APIKey)
	}
	if len(body.APIKey.AccountIDs) != 1 || body.APIKey.AccountIDs[0] != "free-b" {
		t.Fatalf("regenerate lost the allowlist: %v", body.APIKey.AccountIDs)
	}

	old := serveWithKey(h, http.MethodGet, "/v1/models", key.Key, "")
	if old.Code != http.StatusUnauthorized {
		t.Fatalf("old value after regenerate: status=%d, want 401", old.Code)
	}
	if rec := serveWithKey(h, http.MethodGet, "/v1/models", body.Key, ""); rec.Code != http.StatusOK {
		t.Fatalf("new value: status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, adminRequestForTest(t, h, http.MethodPost, "/admin/api/api-keys/missing/regenerate"))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), codeAPIKeyNotFound) {
		t.Fatalf("missing key: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func errorMessageOf(t *testing.T, rec *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	var body struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body.Error.Type, body.Error.Message
}

func TestApiKeyCallLimitReturns429(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-call-limit", CallLimit: 2})
	requireKeys(t)

	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("first call: %d %s", rec.Code, rec.Body.String())
	}

	// One call left, and another request holds it: the reservation refuses.
	if _, err := config.ReserveApiKeyRequestUsage(key.ID, 1); err != nil {
		t.Fatalf("hold the last slot: %v", err)
	}
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody)
	errType, message := errorMessageOf(t, rec)
	if rec.Code != http.StatusTooManyRequests || errType != "rate_limit_error" ||
		message != "API key call limit reached: 1 of 2 successful calls used, 1 more in progress" {
		t.Fatalf("in-flight limit: status=%d type=%s message=%q", rec.Code, errType, message)
	}
	if err := config.FinalizeApiKeyUsageReservation(key.ID, 1, 0, 1, 0); err != nil {
		t.Fatalf("finish the held call: %v", err)
	}

	// Used up: authentication refuses, in the Anthropic and the OpenAI shape.
	const want = "API key call limit reached: 2 of 2 successful calls used"
	rec = serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody)
	if errType, message := errorMessageOf(t, rec); rec.Code != http.StatusTooManyRequests || errType != "rate_limit_error" || message != want {
		t.Fatalf("claude: status=%d type=%s message=%q", rec.Code, errType, message)
	}
	rec = serveWithKey(h, http.MethodPost, "/v1/chat/completions", key.Key, boundKeyOpenAIBody)
	if errType, message := errorMessageOf(t, rec); rec.Code != http.StatusTooManyRequests || errType != "rate_limit_error" || message != want {
		t.Fatalf("openai: status=%d type=%s message=%q", rec.Code, errType, message)
	}
	if calls := len(served.list()); calls != 1 {
		t.Fatalf("upstream calls = %d, want 1: refused calls must not reach upstream", calls)
	}
	got := config.GetApiKeyEntry(key.ID)
	if got.SuccessfulCalls != 2 || !got.Enabled {
		t.Fatalf("after the limit: successfulCalls=%d enabled=%v", got.SuccessfulCalls, got.Enabled)
	}

	// Reset usage gives the calls back at once.
	if err := config.ResetApiKeyUsage(key.ID); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if rec := serveWithKey(h, http.MethodPost, "/v1/chat/completions", key.Key, boundKeyOpenAIBody); rec.Code != http.StatusOK {
		t.Fatalf("after reset: %d %s", rec.Code, rec.Body.String())
	}
}

// Only requests that finished OK count: model lists, token counts and failed
// requests leave successfulCalls alone.
func TestModelsAndCountTokensDoNotCountCalls(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, func(w http.ResponseWriter, r *http.Request) {
		served.add(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"Improperly formed request."}`))
	}, "free-a")
	h.cachedModels = []ModelInfo{{ModelId: "claude-sonnet-4.5"}}
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-no-count", CallLimit: 1})
	requireKeys(t)

	for _, path := range []string{"/v1/models", "/v1/codex/models"} {
		if rec := serveWithKey(h, http.MethodGet, path, key.Key, ""); rec.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, rec.Code)
		}
	}
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages/count_tokens", key.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("count_tokens: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, `{"model":"claude-sonnet-4.5","messages":[]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid request: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody); rec.Code == http.StatusOK {
		t.Fatalf("an upstream 400 answered 200: %s", rec.Body.String())
	}
	if len(served.list()) == 0 {
		t.Fatal("the failing request never reached upstream")
	}
	got := config.GetApiKeyEntry(key.ID)
	if got.SuccessfulCalls != 0 {
		t.Fatalf("successfulCalls = %d, want 0", got.SuccessfulCalls)
	}
	// The failed call gave its slot back: the one allowed call is still there.
	if _, err := config.ReserveApiKeyRequestUsage(key.ID, 1); err != nil {
		t.Fatalf("the slot was not released: %v", err)
	}
}

func TestAdminApiKeyAccountIDsRoundTrip(t *testing.T) {
	h := newKeyAccessHandler(t, nil, "acct-a", "acct-b")

	rec := httptest.NewRecorder()
	h.apiCreateApiKey(rec, httptest.NewRequest(http.MethodPost, "/admin/api/api-keys",
		strings.NewReader(`{"name":"bound","accountIds":["acct-b"," acct-a ","acct-b"],"callLimit":3}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID     string     `json:"id"`
		APIKey apiKeyView `json:"apiKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if strings.Join(created.APIKey.AccountIDs, ",") != "acct-b,acct-a" || created.APIKey.CallLimit != 3 {
		t.Fatalf("create view = %+v", created.APIKey)
	}

	update := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.apiUpdateApiKey(rec, httptest.NewRequest(http.MethodPut, "/admin/api/api-keys/"+created.ID, strings.NewReader(body)), created.ID)
		return rec
	}
	// A rename keeps the binding and the limit.
	if rec := update(`{"name":"renamed"}`); rec.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	if got := config.GetApiKeyEntry(created.ID); strings.Join(got.AccountIDs, ",") != "acct-b,acct-a" || got.CallLimit != 3 {
		t.Fatalf("rename changed access: %+v", got)
	}
	for _, tc := range []struct{ body, code string }{
		{`{"accountIds":["acct-ghost"]}`, codeAPIKeyUnknownAccount},
		{`{"callLimit":-1}`, codeCallLimitNegative},
	} {
		rec := update(tc.body)
		if rec.Code != http.StatusBadRequest || decodeAdminError(t, rec)["code"] != tc.code {
			t.Fatalf("%s: %d %s, want 400 %s", tc.body, rec.Code, rec.Body.String(), tc.code)
		}
	}
	if rec := update(`{"accountIds":[],"callLimit":0}`); rec.Code != http.StatusOK {
		t.Fatalf("clear: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.apiListApiKeys(rec, httptest.NewRequest(http.MethodGet, "/admin/api/api-keys", nil))
	if !strings.Contains(rec.Body.String(), `"accountIds":[]`) || !strings.Contains(rec.Body.String(), `"successfulCalls":0`) {
		t.Fatalf("list must send accountIds as an array and successfulCalls: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"callLimit"`) {
		t.Fatalf("a cleared call limit is still listed: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.apiCreateApiKey(rec, httptest.NewRequest(http.MethodPost, "/admin/api/api-keys", strings.NewReader(`{"accountIds":["nope"]}`)))
	if rec.Code != http.StatusBadRequest || decodeAdminError(t, rec)["code"] != codeAPIKeyUnknownAccount {
		t.Fatalf("create with unknown account: %d %s", rec.Code, rec.Body.String())
	}
}

// The web search tool picks its account apart from the chat call; it follows
// the key's allowlist too.
func TestWebSearchHonorsApiKeyAllowlist(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a", "off-b")
	bound := config.ApiKeyEntry{ID: "k-search", Key: "sk-search", AccountIDs: []string{"off-b"}}
	ctx := withApiKeyContext(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), &bound).Context()

	_, account, err := h.searchWebWithFailover(ctx, "claude-sonnet-4.5", "kiro")
	if !errors.Is(err, errNoWebSearchAccounts) || account != nil {
		t.Fatalf("bound to a disabled account: account=%v err=%v, want errNoWebSearchAccounts", account, err)
	}
	if tokens := served.list(); len(tokens) != 0 {
		t.Fatalf("web search spilled over to %v", tokens)
	}
}
