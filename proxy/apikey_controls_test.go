package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
)

func tagAccount(t *testing.T, id string, tags ...string) {
	t.Helper()
	if err := config.EditAccountMetadata(id, func(notes string, _ []string) (string, []string, error) {
		return notes, tags, nil
	}); err != nil {
		t.Fatalf("tag %s: %v", id, err)
	}
}

func errorBody(t *testing.T, rec *httptest.ResponseRecorder) (errType, message, code string) {
	t.Helper()
	var body struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return body.Error.Type, body.Error.Message, body.Error.Code
}

func TestExpiredApiKeyIsRefusedOnBothAPIs(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "exp-a")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-expiring", ExpiresAt: time.Now().Add(time.Hour).Unix()})
	requireKeys(t)
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("before expiry: %d %s", rec.Code, rec.Body.String())
	}

	// Expire it mid-session: the next request gets 401 with a clear message.
	patch := *config.GetApiKeyEntry(key.ID)
	patch.Key = ""
	patch.ExpiresAt = time.Now().Add(-time.Minute).Unix()
	if err := config.UpdateApiKey(key.ID, patch); err != nil {
		t.Fatalf("expire: %v", err)
	}
	for _, path := range []string{"/v1/messages", "/v1/chat/completions"} {
		body := boundKeyClaudeBody
		if path != "/v1/messages" {
			body = boundKeyOpenAIBody
		}
		rec := serveWithKey(h, http.MethodPost, path, key.Key, body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s expired: %d %s", path, rec.Code, rec.Body.String())
		}
		if _, msg, _ := errorBody(t, rec); !strings.HasPrefix(msg, "API key expired at ") || !strings.HasSuffix(msg, " UTC") {
			t.Fatalf("%s message = %q", path, msg)
		}
		if rec.Header().Get(shouldRetryHeader) != "false" {
			t.Fatalf("%s: an expired key must not be retried", path)
		}
	}
	if n := len(served.list()); n != 1 {
		t.Fatalf("upstream calls = %d, want only the one before expiry", n)
	}
}

func TestApiKeyRPMLimitAnswers429WithRetryAfter(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "rpm-a")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-rpm-limited", RPMLimit: 2})
	other := addTestKey(t, config.ApiKeyEntry{Key: "sk-rpm-free"})
	requireKeys(t)
	t.Cleanup(func() { apiKeyRPM.forget(key.ID) })

	for i := 0; i < 2; i++ {
		if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
			t.Fatalf("request %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	for _, tc := range []struct{ path, body string }{
		{"/v1/messages", boundKeyClaudeBody},
		{"/v1/chat/completions", boundKeyOpenAIBody},
	} {
		rec := serveWithKey(h, http.MethodPost, tc.path, key.Key, tc.body)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("%s third request: %d %s", tc.path, rec.Code, rec.Body.String())
		}
		retry, err := strconv.Atoi(rec.Header().Get("Retry-After"))
		if err != nil || retry < 1 || retry > 60 {
			t.Fatalf("%s Retry-After = %q, want 1..60 seconds", tc.path, rec.Header().Get("Retry-After"))
		}
		if rec.Header().Get(shouldRetryHeader) == "false" {
			t.Fatalf("%s: an RPM refusal clears with time and must stay retryable", tc.path)
		}
		errType, msg, _ := errorBody(t, rec)
		if errType != "rate_limit_error" || msg != "API key rate limit reached: 2 requests per minute" {
			t.Fatalf("%s error = %q %q", tc.path, errType, msg)
		}
	}
	// Another key is not held back, and listing models never counts.
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", other.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("other key: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveWithKey(h, http.MethodGet, "/v1/models", key.Key, ""); rec.Code != http.StatusOK {
		t.Fatalf("models with a limited key: %d", rec.Code)
	}
}

func TestApiKeyRPMWindowSlides(t *testing.T) {
	r := &apiKeyRPMStarts{}
	t0 := time.Unix(1_900_000_000, 0)
	for i := 0; i < 3; i++ {
		if _, ok := r.take("k", 3, t0.Add(time.Duration(i)*10*time.Second)); !ok {
			t.Fatalf("start %d refused", i)
		}
	}
	wait, ok := r.take("k", 3, t0.Add(30*time.Second))
	if ok || wait != 30*time.Second {
		t.Fatalf("fourth start: ok=%v wait=%v, want refused with 30s", ok, wait)
	}
	if _, ok := r.take("k", 3, t0.Add(60*time.Second+time.Millisecond)); !ok {
		t.Fatal("the oldest start left the window but the key is still refused")
	}
	// A lowered limit counts the newest starts.
	if wait, ok := r.take("k", 1, t0.Add(61*time.Second)); ok || wait <= 0 {
		t.Fatalf("lowered limit: ok=%v wait=%v", ok, wait)
	}
	// Limit 0 forgets the key.
	if _, ok := r.take("k", 0, t0); !ok || len(r.m["k"]) != 0 {
		t.Fatal("limit 0 still tracks the key")
	}
}

func TestApiKeyAllowedModelsRefuseOtherModels(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "mod-a")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-models", AllowedModels: []string{"claude-haiku-4.5"}})
	requireKeys(t)

	claude := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody)
	if claude.Code != http.StatusForbidden {
		t.Fatalf("claude: %d %s", claude.Code, claude.Body.String())
	}
	if errType, msg, _ := errorBody(t, claude); errType != "permission_error" || !strings.Contains(msg, `model "claude-sonnet-4.5" is not allowed for this API key`) {
		t.Fatalf("claude error = %q %q", errType, msg)
	}
	openai := serveWithKey(h, http.MethodPost, "/v1/chat/completions", key.Key, boundKeyOpenAIBody)
	if openai.Code != http.StatusForbidden {
		t.Fatalf("openai: %d %s", openai.Code, openai.Body.String())
	}
	if _, _, code := errorBody(t, openai); code != "model_not_allowed" {
		t.Fatalf("openai code = %q", code)
	}
	// The resolved name counts: the dashed Claude spelling resolves to the allowed model.
	dashed := strings.Replace(boundKeyClaudeBody, "claude-sonnet-4.5", "claude-haiku-4-5", 1)
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, dashed); rec.Code != http.StatusOK {
		t.Fatalf("dashed haiku name: %d %s", rec.Code, rec.Body.String())
	}
	if n := len(served.list()); n != 1 {
		t.Fatalf("upstream calls = %d, want 1", n)
	}
	// /v1/models shows only what the key may call.
	rec := serveWithKey(h, http.MethodGet, "/v1/models", key.Key, "")
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("models: %v %s", err, rec.Body.String())
	}
	if len(list.Data) == 0 {
		t.Fatal("models list is empty")
	}
	for _, m := range list.Data {
		if resolved, _ := ParseModelAndThinking(m.ID, config.GetThinkingConfig().Suffix); !strings.EqualFold(resolved, "claude-haiku-4.5") {
			t.Fatalf("models lists %q for a haiku-only key", m.ID)
		}
	}
	one := serveWithKey(h, http.MethodGet, "/v1/models/claude-sonnet-4.5", key.Key, "")
	if one.Code != http.StatusNotFound {
		t.Fatalf("one model: %d %s", one.Code, one.Body.String())
	}
	if _, msg, code := errorBody(t, one); msg != `model "claude-sonnet-4.5" is not available to this API key` || code != "model_not_found" {
		t.Fatalf("one model error = %q %q", msg, code)
	}
}

func TestApiKeyTagScopeRoutesOnlyToTaggedAccounts(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "tag-a", "tag-b", "tag-c")
	tagAccount(t, "tag-b", "Team-Blue")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-tagged", AccountTags: []string{"team-blue"}, AccountIDs: []string{"tag-c"}})
	none := addTestKey(t, config.ApiKeyEntry{Key: "sk-tag-nobody", AccountTags: []string{"ghost"}})
	requireKeys(t)

	for i := 0; i < 6; i++ {
		//! A new conversation each time: affinity would keep one conversation on one account.
		body := strings.Replace(boundKeyClaudeBody, `"hi"`, `"hi `+strconv.Itoa(i)+`"`, 1)
		if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, body); rec.Code != http.StatusOK {
			t.Fatalf("request %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	seen := map[string]bool{}
	for _, token := range served.list() {
		seen[token] = true
	}
	if seen["token-tag-a"] || !seen["token-tag-b"] || !seen["token-tag-c"] {
		t.Fatalf("served by %v, want tag-b (tag) and tag-c (id) only", seen)
	}

	rec := serveWithKey(h, http.MethodPost, "/v1/messages", none.Key, boundKeyClaudeBody)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("tag without accounts: %d %s", rec.Code, rec.Body.String())
	}
	if _, msg, _ := errorBody(t, rec); msg != "No account matches this API key's account tags (ghost)" {
		t.Fatalf("message = %q", msg)
	}

	// Tagging an account brings it into the scope on the next request.
	tagAccount(t, "tag-a", "ghost")
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", none.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("after tagging: %d %s", rec.Code, rec.Body.String())
	}
}

func TestApiKeyRoutingModeAndAffinityStayInScope(t *testing.T) {
	h := affinityTestHandler(t, "rm-a", "rm-b", "rm-c")
	for id, days := range map[string]int{"rm-a": 20, "rm-b": 3, "rm-c": 9} {
		if err := config.UpdateAccountInfo(id, config.AccountInfo{UsageLimit: 500, NextResetDate: time.Now().AddDate(0, 0, days).Format("2006-01-02")}); err != nil {
			t.Fatal(err)
		}
	}
	h.pool.Reload()
	keyEntry := config.ApiKeyEntry{ID: "k-reset", Key: "sk-reset", RoutingMode: config.RoutingModeResetFirst, AccountIDs: []string{"rm-a", "rm-c"}}
	ctx := withApiKeyContext(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), &keyEntry).Context()

	// Reset first, inside the key's accounts: rm-c resets before rm-a (rm-b is outside).
	conv := payloadFor("shared-conversation")
	for i := 0; i < 3; i++ {
		if acc := h.pickAccount(ctx, payloadFor("fresh-"+strconv.Itoa(i)), "", nil); acc == nil || acc.ID != "rm-c" {
			t.Fatalf("pick %d = %v, want rm-c", i, acc)
		}
	}

	// A request without a key binds the conversation to rm-b; the scoped key keeps its own binding.
	h.rememberAccount(context.Background(), conv, h.pool.GetByID("rm-b"))
	acc := h.pickAccount(ctx, conv, "", nil)
	if acc == nil || acc.ID != "rm-c" {
		t.Fatalf("scoped key with a global binding = %v, want rm-c", acc)
	}
	h.rememberAccount(ctx, conv, acc)
	if got := h.affinity.Lookup(affinityKey(conv)); got != "rm-b" {
		t.Fatalf("the scoped key overwrote the global binding: %q", got)
	}
	if got := h.affinity.Lookup(affinityKeyFor(ctx, conv)); got != "rm-c" {
		t.Fatalf("scoped binding = %q, want rm-c", got)
	}
}

func TestAdminApiKeyControlsRoundTrip(t *testing.T) {
	h := newKeyAccessHandler(t, nil, "adm-a")
	body := `{"name":"ctl","accountTags":["eu"],"allowedModels":["claude-haiku-4.5"],"rpmLimit":12,"expiresAt":1,"routingMode":"reset_first"}`
	adminCall := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header = adminRequestForTest(t, h, method, path).Header
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := adminCall(http.MethodPost, "/admin/api/api-keys", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		APIKey apiKeyView `json:"apiKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	v := created.APIKey
	if !v.Expired || v.RoutingMode != "reset_first" || v.RPMLimit != 12 || len(v.AccountTags) != 1 || len(v.AllowedModels) != 1 {
		t.Fatalf("view = %+v", v)
	}

	put := func(body string) *httptest.ResponseRecorder {
		return adminCall(http.MethodPut, "/admin/api/api-keys/"+v.ID, body)
	}
	if rec := put(`{"routingMode":"inherit","expiresAt":0,"accountTags":[],"allowedModels":[]}`); rec.Code != http.StatusOK {
		t.Fatalf("clear: %d %s", rec.Code, rec.Body.String())
	} else if !strings.Contains(rec.Body.String(), `"routingMode":"inherit"`) || !strings.Contains(rec.Body.String(), `"expired":false`) ||
		!strings.Contains(rec.Body.String(), `"accountTags":[]`) || !strings.Contains(rec.Body.String(), `"allowedModels":[]`) {
		t.Fatalf("cleared view = %s", rec.Body.String())
	}
	for body, code := range map[string]string{
		`{"rpmLimit":-1}`:          codeAPIKeyRPMLimitRange,
		`{"rpmLimit":10001}`:       codeAPIKeyRPMLimitRange,
		`{"expiresAt":-3}`:         codeAPIKeyExpiryInvalid,
		`{"routingMode":"random"}`: codeAPIKeyRoutingMode,
	} {
		rec := put(body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"`+code+`"`) {
			t.Fatalf("%s: %d %s, want 400 %s", body, rec.Code, rec.Body.String(), code)
		}
	}
}

func TestScopedKeyAtAccountRPMLimitNamesItsScope(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "lim-a", "lim-b")
	tagAccount(t, "lim-a", "solo")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-solo-scope", AccountTags: []string{"solo"}})
	open := addTestKey(t, config.ApiKeyEntry{Key: "sk-solo-open"})
	requireKeys(t)
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = config.UpdateAccountRPMLimit(0) })

	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("first: %d %s", rec.Code, rec.Body.String())
	}
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, strings.Replace(boundKeyClaudeBody, `"hi"`, `"again"`, 1))
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("scoped key at its account's limit: %d %q %s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if _, msg, _ := errorBody(t, rec); msg != "Every account this API key can use reached the limit of 1 request per minute" {
		t.Fatalf("message = %q", msg)
	}
	// The other account is free, so a key without a scope is served.
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", open.Key, strings.Replace(boundKeyClaudeBody, `"hi"`, `"open"`, 1)); rec.Code != http.StatusOK {
		t.Fatalf("open key: %d %s", rec.Code, rec.Body.String())
	}
}
