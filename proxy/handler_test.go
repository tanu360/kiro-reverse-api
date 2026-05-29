package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestThinkingSourceReasoningFirst(t *testing.T) {
	var source thinkingStreamSource

	if !allowReasoningSource(&source) {
		t.Fatalf("expected reasoning source to be accepted first")
	}
	if source != thinkingSourceReasoningEvent {
		t.Fatalf("expected source to be reasoning, got %v", source)
	}
	if allowTagSource(&source) {
		t.Fatalf("expected tag source to be rejected after reasoning source selected")
	}
}

func TestClaudeNonStreamRetriesNextAccountAfterPreResponseFailure(t *testing.T) {
	resetObservePersistenceForTest(t)
	cfgFile := t.TempDir() + "/kiro.db"
	if err := config.Init(cfgFile); err != nil {
		t.Fatalf("config.Init: %v", err)
	}

	if err := config.AddAccount(config.Account{
		ID:          "first",
		Enabled:     true,
		AccessToken: "token-first",
		ProfileArn:  "arn:aws:codewhisperer:profile/first",
	}); err != nil {
		t.Fatalf("add first account: %v", err)
	}
	if err := config.AddAccount(config.Account{
		ID:          "second",
		Enabled:     true,
		AccessToken: "token-second",
		ProfileArn:  "arn:aws:codewhisperer:profile/second",
	}); err != nil {
		t.Fatalf("add second account: %v", err)
	}
	if err := config.UpdatePreferredEndpoint("kiro"); err != nil {
		t.Fatalf("set preferred endpoint: %v", err)
	}
	if err := config.UpdateEndpointFallback(false); err != nil {
		t.Fatalf("disable endpoint fallback: %v", err)
	}

	requestTokens := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		requestTokens = append(requestTokens, token)
		if token == "token-first" {
			http.Error(w, "temporary upstream failure", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{
			"content": "retried successfully",
		}))
	}))
	defer server.Close()

	oldEndpoints := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{{
		URL:    server.URL,
		Origin: "AI_EDITOR",
		Name:   "test",
	}}
	defer func() { kiroEndpoints = oldEndpoints }()

	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Timeout: time.Second, Transport: &http.Transport{}})
	defer kiroHttpStore.Store(oldClient)

	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{
		pool:        p,
		promptCache: newPromptCacheTracker(defaultPromptCacheTTL),
	}

	payload := &KiroPayload{}
	payload.ConversationState.CurrentMessage.UserInputMessage = KiroUserInputMessage{
		Content: "hello",
		ModelID: "claude-sonnet-4.5",
		Origin:  "AI_EDITOR",
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	h.handleClaudeNonStream(rec, req, payload, "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected retry to succeed, status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(requestTokens) != 4 {
		t.Fatalf("expected four account attempts, got %v", requestTokens)
	}
	if requestTokens[0] != "token-first" || requestTokens[1] != "token-first" || requestTokens[2] != "token-first" || requestTokens[3] != "token-second" {
		t.Fatalf("expected first account to be excluded before retry, got %v", requestTokens)
	}

	var resp ClaudeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Content) == 0 || resp.Content[0].Text != "retried successfully" {
		t.Fatalf("expected retried response content, got %#v", resp.Content)
	}

	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatalf("query request stats: %v", err)
	}
	if stats.TotalRequests != 1 || stats.SuccessRequests != 1 || stats.FailedRequests != 0 {
		t.Fatalf("expected one final successful request row, got %#v", stats)
	}
	errors, err := loadRecentErrorsFromDB(10)
	if err != nil {
		t.Fatalf("load errors: %v", err)
	}
	if len(errors) != 3 {
		t.Fatalf("expected three retry error rows, got %d", len(errors))
	}
}

func TestClaudeNonStreamNoAccountsRecordsOneFailedRequest(t *testing.T) {
	resetObservePersistenceForTest(t)
	cfgFile := t.TempDir() + "/kiro.db"
	if err := config.Init(cfgFile); err != nil {
		t.Fatalf("config.Init: %v", err)
	}

	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{
		pool:        p,
		promptCache: newPromptCacheTracker(defaultPromptCacheTTL),
	}
	payload := &KiroPayload{}
	payload.ConversationState.CurrentMessage.UserInputMessage = KiroUserInputMessage{
		Content: "hello",
		ModelID: "claude-sonnet-4.5",
		Origin:  "AI_EDITOR",
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	h.handleClaudeNonStream(rec, req, payload, "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected no-account failure, status=%d body=%s", rec.Code, rec.Body.String())
	}
	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatalf("query request stats: %v", err)
	}
	if stats.TotalRequests != 1 || stats.SuccessRequests != 0 || stats.FailedRequests != 1 {
		t.Fatalf("expected one final failed request row, got %#v", stats)
	}
	page := getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 10, Status: "failed"})
	if page.Total != 1 || len(page.Requests) != 1 || page.Requests[0].Status != http.StatusServiceUnavailable {
		t.Fatalf("unexpected failed request page: total=%d rows=%#v", page.Total, page.Requests)
	}
}

func TestClaudeAuthFailureRecordsOneFailedRequest(t *testing.T) {
	resetObservePersistenceForTest(t)
	cfgFile := t.TempDir() + "/kiro.db"
	if err := config.Init(cfgFile); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	require := true
	if err := config.UpdateSettingsPatch(&require, ""); err != nil {
		t.Fatalf("enable auth: %v", err)
	}

	h := &Handler{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}],"max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer sk-missing")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected auth failure, status=%d body=%s", rec.Code, rec.Body.String())
	}
	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatalf("query request stats: %v", err)
	}
	if stats.TotalRequests != 1 || stats.SuccessRequests != 0 || stats.FailedRequests != 1 {
		t.Fatalf("expected one auth-failed request row, got %#v", stats)
	}
	page := getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 10, Status: "failed"})
	if page.Total != 1 || len(page.Requests) != 1 || page.Requests[0].APIKeyMasked != "sk-missing" {
		t.Fatalf("unexpected failed auth request page: total=%d rows=%#v", page.Total, page.Requests)
	}
}

func TestAccountCreditTotalsSumsServerUsage(t *testing.T) {
	used, limit := accountCreditTotals([]config.Account{
		{UsageCurrent: 66, UsageLimit: 1000},
		{UsageCurrent: 2, UsageLimit: 1000},
		{UsageCurrent: 745, UsageLimit: 1000},
	})
	if used != 813 || limit != 3000 {
		t.Fatalf("expected 813/3000, got %.1f/%.1f", used, limit)
	}
}

func TestStatusPayloadUsesRequestDBAndAccountCredits(t *testing.T) {
	resetObservePersistenceForTest(t)
	cfgFile := t.TempDir() + "/kiro.db"
	if err := config.Init(cfgFile); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, account := range []config.Account{
		{ID: "acc-1", Enabled: true, UsageCurrent: 66, UsageLimit: 1000},
		{ID: "acc-2", Enabled: true, UsageCurrent: 2, UsageLimit: 1000},
	} {
		if err := config.AddAccount(account); err != nil {
			t.Fatalf("add account: %v", err)
		}
	}
	s := getObserveStore()
	defer s.Reset()
	s.RecordRequest("acc-1", "one@example.com", "claude-sonnet", 10, 20, 0.30, true, http.StatusOK, "")
	s.RecordRequest("acc-2", "two@example.com", "claude-opus", 0, 0, 0, false, http.StatusInternalServerError, "boom")
	s.RecordError("acc-2", "two@example.com", "claude-opus", http.StatusInternalServerError, "boom")

	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p, startTime: time.Now().Unix()}
	rec := httptest.NewRecorder()
	h.apiGetStatus(rec, httptest.NewRequest(http.MethodGet, "/admin/api/status", nil))

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if body["accounts"].(float64) != 2 || body["totalRequests"].(float64) != 2 || body["successRequests"].(float64) != 1 || body["failedRequests"].(float64) != 1 {
		t.Fatalf("unexpected status counts: %#v", body)
	}
	if body["totalTokens"].(float64) != 30 {
		t.Fatalf("expected 30 app tokens, got %#v", body["totalTokens"])
	}
	if math.Abs(body["totalCredits"].(float64)-0.30) > 0.000001 {
		t.Fatalf("expected 0.30 app credits, got %#v", body["totalCredits"])
	}
	if body["successTokens"].(float64) != 30 {
		t.Fatalf("expected 30 success tokens, got %#v", body["successTokens"])
	}
	if body["successInTokens"].(float64) != 10 {
		t.Fatalf("expected 10 success input tokens, got %#v", body["successInTokens"])
	}
	if body["successOutTokens"].(float64) != 20 {
		t.Fatalf("expected 20 success output tokens, got %#v", body["successOutTokens"])
	}
	if math.Abs(body["successCredits"].(float64)-0.30) > 0.000001 {
		t.Fatalf("expected 0.30 success credits, got %#v", body["successCredits"])
	}
	if body["totalErrorEvents"].(float64) != 1 {
		t.Fatalf("expected 1 error event, got %#v", body["totalErrorEvents"])
	}
	if body["accountCreditsUsed"].(float64) != 68 || body["accountCreditsLimit"].(float64) != 2000 {
		t.Fatalf("unexpected account credits: used=%#v limit=%#v", body["accountCreditsUsed"], body["accountCreditsLimit"])
	}
}

func TestUpdateSettingsReloadsPoolAfterAllowOverUsageChange(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{
		ID:           "over",
		Enabled:      true,
		UsageCurrent: 10,
		UsageLimit:   10,
	}); err != nil {
		t.Fatalf("add account: %v", err)
	}

	p := accountpool.GetPool()
	p.Reload()
	if got := p.GetNext(); got != nil {
		t.Fatalf("expected over-quota account to be unavailable before enabling allowOverUsage, got %#v", got)
	}

	h := &Handler{pool: p}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(`{"allowOverUsage":true}`))
	h.apiUpdateSettings(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected settings update to succeed, status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := p.GetNext(); got == nil || got.ID != "over" {
		t.Fatalf("expected pool reload to make over-quota account routable, got %#v", got)
	}
}

func TestBatchDeleteAccounts(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, account := range []config.Account{
		{ID: "keep", Enabled: true},
		{ID: "delete-a", Enabled: true},
		{ID: "delete-b", Enabled: true},
	} {
		if err := config.AddAccount(account); err != nil {
			t.Fatalf("add account %s: %v", account.ID, err)
		}
	}

	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/admin/api/accounts/batch", strings.NewReader(`{"ids":["delete-a","delete-b","missing"],"action":"delete"}`))
	h.apiBatchAccounts(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected batch delete to succeed, status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	if body["deleted"].(float64) != 2 || body["failed"].(float64) != 1 {
		t.Fatalf("unexpected delete counts: %#v", body)
	}
	accounts := config.GetAccounts()
	if len(accounts) != 1 || accounts[0].ID != "keep" {
		t.Fatalf("expected only keep account to remain, got %#v", accounts)
	}
	if got := p.GetNext(); got == nil || got.ID != "keep" {
		t.Fatalf("expected pool reload to keep only remaining account, got %#v", got)
	}
}

func TestThinkingSourceTagFirst(t *testing.T) {
	var source thinkingStreamSource

	if !allowTagSource(&source) {
		t.Fatalf("expected tag source to be accepted first")
	}
	if source != thinkingSourceTagBlock {
		t.Fatalf("expected source to be tag, got %v", source)
	}
	if allowReasoningSource(&source) {
		t.Fatalf("expected reasoning source to be rejected after tag source selected")
	}
}

func TestThinkingSourceSameSourceRemainsAllowed(t *testing.T) {
	var source thinkingStreamSource

	if !allowTagSource(&source) {
		t.Fatalf("expected initial tag source selection to succeed")
	}
	if !allowTagSource(&source) {
		t.Fatalf("expected repeated tag source selection to stay allowed")
	}

	source = thinkingSourceUnknown
	if !allowReasoningSource(&source) {
		t.Fatalf("expected initial reasoning source selection to succeed")
	}
	if !allowReasoningSource(&source) {
		t.Fatalf("expected repeated reasoning source selection to stay allowed")
	}
}

func TestValidateOpenAIRequestShapeRejectsAssistantPrefill(t *testing.T) {
	req := &OpenAIRequest{
		Messages: []OpenAIMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "prefill"},
		},
	}

	if msg := validateOpenAIRequestShape(req); msg == "" {
		t.Fatalf("expected assistant-prefill final message to be rejected")
	}
}

func TestValidateOpenAIRequestShapeAllowsToolResultFinalTurn(t *testing.T) {
	req := &OpenAIRequest{
		Messages: []OpenAIMessage{
			{Role: "user", Content: "find weather"},
			{
				Role: "assistant",
				ToolCalls: []ToolCall{{
					ID:   "call_1",
					Type: "function",
					Function: struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					}{Name: "get_weather", Arguments: "{}"},
				}},
			},
			{Role: "tool", ToolCallID: "call_1", Content: "sunny"},
		},
	}

	if msg := validateOpenAIRequestShape(req); msg != "" {
		t.Fatalf("expected tool-result final turn to be valid, got %q", msg)
	}
}

func TestAuthenticateMultiApiKeyAndLimits(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	require := true
	if err := config.UpdateSettingsPatch(&require, ""); err != nil {
		t.Fatalf("enable auth: %v", err)
	}
	h := &Handler{}

	missing := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	if _, err := h.authenticate(missing); err == nil {
		t.Fatalf("expected fail-closed error when auth is enabled without keys")
	}

	entry, err := config.AddApiKey(config.ApiKeyEntry{Name: "limited", Key: "sk-limited", Enabled: true, TokenLimit: 10})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	okReq := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	okReq.Header.Set("Authorization", "Bearer sk-limited")
	got, err := h.authenticate(okReq)
	if err != nil {
		t.Fatalf("authenticate valid key: %v", err)
	}
	if got == nil || got.ID != entry.ID {
		t.Fatalf("expected matched key in auth result, got %#v", got)
	}

	if err := config.RecordApiKeyUsage(entry.ID, 10, 0); err != nil {
		t.Fatalf("record key usage: %v", err)
	}
	if _, err := h.authenticate(okReq); err == nil || !strings.Contains(err.Error(), "token limit exceeded") {
		t.Fatalf("expected token limit error, got %v", err)
	}
}

func TestApiKeyListMasksAndDetailReturnsCopyableKey(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	entry, err := config.AddApiKey(config.ApiKeyEntry{Name: "client", Key: "sk-copyable", Enabled: true})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	h := &Handler{}

	listRec := httptest.NewRecorder()
	h.apiListApiKeys(listRec, httptest.NewRequest(http.MethodGet, "/admin/api/api-keys", nil))
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", listRec.Code, listRec.Body.String())
	}
	var listBody struct {
		ApiKeys []map[string]interface{} `json:"apiKeys"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listBody.ApiKeys) != 1 {
		t.Fatalf("expected one key, got %#v", listBody.ApiKeys)
	}
	if _, ok := listBody.ApiKeys[0]["key"]; ok {
		t.Fatalf("list response must not expose raw key")
	}
	if listBody.ApiKeys[0]["keyMasked"] == "" {
		t.Fatalf("expected masked key in list response")
	}

	getRec := httptest.NewRecorder()
	h.apiGetApiKey(getRec, httptest.NewRequest(http.MethodGet, "/admin/api/api-keys/"+entry.ID, nil), entry.ID)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get status = %d body=%s", getRec.Code, getRec.Body.String())
	}
	var detail map[string]interface{}
	if err := json.Unmarshal(getRec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detail["key"] != "sk-copyable" {
		t.Fatalf("expected detail response to include copyable key, got %#v", detail["key"])
	}
}

func TestModelsEndpointRequiresManagedApiKey(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	require := true
	if err := config.UpdateSettingsPatch(&require, ""); err != nil {
		t.Fatalf("enable auth: %v", err)
	}
	if _, err := config.AddApiKey(config.ApiKeyEntry{Name: "models", Key: "sk-models", Enabled: true}); err != nil {
		t.Fatalf("add key: %v", err)
	}
	h := &Handler{
		cachedModels: []ModelInfo{{ModelId: "claude-sonnet-4.5", InputTypes: []string{"TEXT"}}},
	}

	missing := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	missingRec := httptest.NewRecorder()
	h.ServeHTTP(missingRec, missing)
	if missingRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected missing key to fail, got %d", missingRec.Code)
	}

	okReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	okReq.Header.Set("Authorization", "Bearer sk-models")
	okRec := httptest.NewRecorder()
	h.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("expected valid key to pass, got %d body=%s", okRec.Code, okRec.Body.String())
	}
}

func TestUnknownManagedApiKeyDoesNotAuthenticate(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	require := true
	if err := config.UpdateSettingsPatch(&require, ""); err != nil {
		t.Fatalf("update settings: %v", err)
	}
	if keys := config.ListApiKeys(); len(keys) != 0 {
		t.Fatalf("expected no managed keys, got %#v", keys)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("Authorization", "Bearer sk-unknown")
	if _, err := (&Handler{}).authenticate(req); err == nil {
		t.Fatalf("expected unknown key to stay invalid")
	}
}

func TestApiKeyReservationRejectsProjectedTokenOverrun(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	entry, err := config.AddApiKey(config.ApiKeyEntry{Name: "limited", Key: "sk-limited", Enabled: true, TokenLimit: 10})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}

	if _, err := reserveApiKeyUsage(entry.ID, entry.Key, 11); err == nil {
		t.Fatalf("expected projected token budget to fail")
	}
	got := config.GetApiKeyEntry(entry.ID)
	if got == nil || got.TokensUsed != 0 || got.RequestsCount != 0 {
		t.Fatalf("failed reservation changed usage: %#v", got)
	}
}

func TestRecordSuccessForApiKeyAttributesUsage(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	entry, err := config.AddApiKey(config.ApiKeyEntry{Name: "usage", Key: "sk-usage", Enabled: true})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	h := &Handler{}
	reservation, err := reserveApiKeyUsage(entry.ID, entry.Key, 10)
	if err != nil {
		t.Fatalf("reserve key usage: %v", err)
	}
	h.recordSuccessForApiKey(reservation, 7, 3, 1.25)

	got := config.GetApiKeyEntry(entry.ID)
	if got == nil || got.TokensUsed != 10 || got.CreditsUsed != 1.25 || got.RequestsCount != 1 {
		t.Fatalf("usage not attributed: %#v", got)
	}
}

func TestFinalizeUsageTokensPrefersProviderUsage(t *testing.T) {
	in, out := finalizeUsageTokens(120, 34, 999, 5000, 88)
	if in != 120 || out != 34 {
		t.Fatalf("expected provider usage to win, got input=%d output=%d", in, out)
	}
}

func TestFinalizeUsageTokensFallsBackWhenProviderUsageMissing(t *testing.T) {
	in, out := finalizeUsageTokens(0, 0, 999, 5000, 88)
	if in != 5000 || out != 88 {
		t.Fatalf("expected context input and estimated output fallback, got input=%d output=%d", in, out)
	}

	in, out = finalizeUsageTokens(0, 0, 999, 0, 88)
	if in != 999 || out != 88 {
		t.Fatalf("expected estimated input fallback, got input=%d output=%d", in, out)
	}
}

func TestValidateClaudeRequestShapeRejectsAssistantPrefill(t *testing.T) {
	req := &ClaudeRequest{
		Messages: []ClaudeMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "prefill"},
		},
	}

	if msg := validateClaudeRequestShape(req); msg == "" {
		t.Fatalf("expected assistant-prefill final message to be rejected")
	}
}

func TestResolveClaudeThinkingModeHonorsRequestThinking(t *testing.T) {
	tests := []struct {
		name         string
		model        string
		thinking     *ClaudeThinkingConfig
		wantModel    string
		wantThinking bool
	}{
		{
			name:         "adaptive request enables thinking",
			model:        "claude-sonnet-4.6",
			thinking:     &ClaudeThinkingConfig{Type: "adaptive"},
			wantModel:    "claude-sonnet-4.6",
			wantThinking: true,
		},
		{
			name:         "enabled request enables thinking",
			model:        "claude-opus-4.5",
			thinking:     &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048},
			wantModel:    "claude-opus-4.5",
			wantThinking: true,
		},
		{
			name:         "disabled request keeps thinking off",
			model:        "claude-opus-4.7",
			thinking:     &ClaudeThinkingConfig{Type: "disabled"},
			wantModel:    "claude-opus-4.7",
			wantThinking: false,
		},
		{
			name:         "suffix remains supported when thinking is disabled",
			model:        "claude-sonnet-4.5-thinking",
			thinking:     &ClaudeThinkingConfig{Type: "disabled"},
			wantModel:    "claude-sonnet-4.5",
			wantThinking: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotModel, gotThinking := resolveClaudeThinkingMode(tc.model, tc.thinking, "-thinking")
			if gotModel != tc.wantModel {
				t.Fatalf("expected model %q, got %q", tc.wantModel, gotModel)
			}
			if gotThinking != tc.wantThinking {
				t.Fatalf("expected thinking=%v, got %v", tc.wantThinking, gotThinking)
			}
		})
	}
}

func TestCloneClaudeRequestForThinkingInjectsPromptWithoutMutatingOriginal(t *testing.T) {
	req := &ClaudeRequest{
		Model:  "claude-sonnet-4.6",
		System: "Follow the user instructions.",
	}

	cloned := cloneClaudeRequestForThinking(req, true)
	blocks, ok := cloned.System.([]interface{})
	if !ok {
		t.Fatalf("expected cloned system prompt to be structured blocks, got %T", cloned.System)
	}
	if len(blocks) != 2 {
		t.Fatalf("expected 2 system blocks after prepend, got %d", len(blocks))
	}
	gotPrompt := extractSystemPrompt(cloned.System)
	expected := ThinkingModePrompt + "\n\nFollow the user instructions."
	if gotPrompt != expected {
		t.Fatalf("expected injected system prompt %q, got %q", expected, gotPrompt)
	}
	if original, ok := req.System.(string); !ok || original != "Follow the user instructions." {
		t.Fatalf("expected original request system prompt to stay unchanged, got %#v", req.System)
	}
}

func TestCloneClaudeRequestForThinkingPreservesStructuredSystemBlocks(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-4.6",
		System: []interface{}{
			map[string]interface{}{
				"type": "text",
				"text": "cached system",
				"cache_control": map[string]interface{}{
					"type": "ephemeral",
					"ttl":  "5m",
				},
			},
		},
	}

	cloned := cloneClaudeRequestForThinking(req, true)
	blocks, ok := cloned.System.([]interface{})
	if !ok {
		t.Fatalf("expected structured system blocks, got %T", cloned.System)
	}
	if len(blocks) != 2 {
		t.Fatalf("expected 2 system blocks after prepend, got %d", len(blocks))
	}
	first, ok := blocks[0].(map[string]interface{})
	if !ok || first["text"] != ThinkingModePrompt+"\n" {
		t.Fatalf("expected first block to be thinking prompt, got %#v", blocks[0])
	}
	second, ok := blocks[1].(map[string]interface{})
	if !ok {
		t.Fatalf("expected original system block to remain a map, got %T", blocks[1])
	}
	cacheControl, ok := second["cache_control"].(map[string]interface{})
	if !ok || cacheControl["type"] != "ephemeral" {
		t.Fatalf("expected original cache_control to be preserved, got %#v", second["cache_control"])
	}
}

func TestThinkingPromptAffectsClaudeTokenEstimate(t *testing.T) {
	req := &ClaudeRequest{
		Model:    "claude-sonnet-4.6",
		Messages: []ClaudeMessage{{Role: "user", Content: "hello"}},
	}

	baseTokens := estimateClaudeRequestInputTokens(req)
	thinkingTokens := estimateClaudeRequestInputTokens(cloneClaudeRequestForThinking(req, true))

	if thinkingTokens <= baseTokens {
		t.Fatalf("expected thinking tokens (%d) to exceed base tokens (%d)", thinkingTokens, baseTokens)
	}
}

func TestValidateClaudeThinkingConfig(t *testing.T) {
	tests := []struct {
		name        string
		thinking    *ClaudeThinkingConfig
		maxTokens   int
		expectError bool
	}{
		{
			name:        "adaptive is valid",
			thinking:    &ClaudeThinkingConfig{Type: "adaptive"},
			maxTokens:   4096,
			expectError: false,
		},
		{
			name:        "enabled requires budget",
			thinking:    &ClaudeThinkingConfig{Type: "enabled"},
			maxTokens:   4096,
			expectError: true,
		},
		{
			name:        "enabled requires at least 1024 budget tokens",
			thinking:    &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 512},
			maxTokens:   4096,
			expectError: true,
		},
		{
			name:        "enabled rejects max tokens zero",
			thinking:    &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048},
			maxTokens:   0,
			expectError: true,
		},
		{
			name:        "enabled budget must stay below max tokens",
			thinking:    &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 4096},
			maxTokens:   4096,
			expectError: true,
		},
		{
			name:        "disabled rejects display",
			thinking:    &ClaudeThinkingConfig{Type: "disabled", Display: "summarized"},
			maxTokens:   4096,
			expectError: true,
		},
		{
			name:        "missing type is rejected",
			thinking:    &ClaudeThinkingConfig{},
			maxTokens:   4096,
			expectError: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			errMsg := validateClaudeThinkingConfig(tc.thinking, tc.maxTokens)
			if tc.expectError && errMsg == "" {
				t.Fatalf("expected validation error")
			}
			if !tc.expectError && errMsg != "" {
				t.Fatalf("expected thinking config to be valid, got %q", errMsg)
			}
		})
	}
}

func TestResolveClaudeThinkingResponseOptions(t *testing.T) {
	tests := []struct {
		name       string
		thinking   *ClaudeThinkingConfig
		defaultFmt string
		wantFmt    string
		wantOmit   bool
	}{
		{
			name:       "default config is preserved when display unset",
			thinking:   &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048},
			defaultFmt: "think",
			wantFmt:    "think",
			wantOmit:   false,
		},
		{
			name:       "summarized forces official thinking blocks",
			thinking:   &ClaudeThinkingConfig{Type: "adaptive", Display: "summarized"},
			defaultFmt: "reasoning_content",
			wantFmt:    "thinking",
			wantOmit:   false,
		},
		{
			name:       "omitted forces official thinking blocks and hides content",
			thinking:   &ClaudeThinkingConfig{Type: "adaptive", Display: "omitted"},
			defaultFmt: "think",
			wantFmt:    "thinking",
			wantOmit:   true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := resolveClaudeThinkingResponseOptions(tc.thinking, tc.defaultFmt)
			if opts.Format != tc.wantFmt {
				t.Fatalf("expected format %q, got %q", tc.wantFmt, opts.Format)
			}
			if opts.OmitDisplay != tc.wantOmit {
				t.Fatalf("expected omitDisplay=%v, got %v", tc.wantOmit, opts.OmitDisplay)
			}
		})
	}
}

func TestMergeUniqueModelsPreservesUnionAcrossAccounts(t *testing.T) {
	base := []ModelInfo{
		{ModelId: "claude-sonnet-4.5", InputTypes: []string{"TEXT"}},
	}
	incoming := []ModelInfo{
		{ModelId: "claude-sonnet-4.5", InputTypes: []string{"image"}},
		{ModelId: "claude-opus-4-7", InputTypes: []string{"text"}},
	}

	merged := mergeUniqueModels(base, incoming)
	if len(merged) != 2 {
		t.Fatalf("expected 2 unique models, got %d", len(merged))
	}
	if !modelSupportsImage(merged[0].InputTypes) {
		t.Fatalf("expected merged input types to preserve image capability, got %#v", merged[0].InputTypes)
	}
	if merged[1].ModelId != "claude-opus-4-7" {
		t.Fatalf("expected second model to be claude-opus-4-7, got %q", merged[1].ModelId)
	}
}

func TestBuildAnthropicModelsResponseGeneratesThinkingVariants(t *testing.T) {
	models := buildAnthropicModelsResponse([]ModelInfo{{
		ModelId:    "claude-sonnet-4.5",
		InputTypes: []string{"text", "image"},
	}}, "-thinking")

	if len(models) != 2 {
		t.Fatalf("expected base model and thinking variant, got %d", len(models))
	}
	if models[0]["id"] != "claude-sonnet-4.5" {
		t.Fatalf("unexpected base model id: %#v", models[0]["id"])
	}
	if models[1]["id"] != "claude-sonnet-4.5-thinking" {
		t.Fatalf("unexpected thinking model id: %#v", models[1]["id"])
	}
	if supportsImage, ok := models[0]["supports_image"].(bool); !ok || !supportsImage {
		t.Fatalf("expected image capability to be preserved, got %#v", models[0]["supports_image"])
	}
}
