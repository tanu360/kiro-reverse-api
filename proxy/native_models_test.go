package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"kiro-proxy/db"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// seedNativeModels publishes ids as the models Kiro lists and clears them when the test ends.
func seedNativeModels(t *testing.T, ids ...string) {
	t.Helper()
	models := make([]ModelInfo, 0, len(ids))
	for _, id := range ids {
		models = append(models, ModelInfo{ModelId: id})
	}
	publishNativeModels(models)
	t.Cleanup(func() { publishNativeModels(nil) })
}

// initDefaultMappingsConfig starts a fresh config, so the default model mappings apply.
func initDefaultMappingsConfig(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("config init: %v", err)
	}
	t.Cleanup(func() { _ = config.UpdateModelMappings(config.DefaultModelMappings()) })
}

func TestNativeModelIDLookup(t *testing.T) {
	publishNativeModels(nil)
	t.Cleanup(func() { publishNativeModels(nil) })

	if _, ok := nativeModelID("gpt-5.6-sol"); ok {
		t.Fatal("unset native set reported a model")
	}

	publishNativeModels([]ModelInfo{{ModelId: " gpt-5.6-sol "}, {ModelId: ""}, {ModelId: "  "}, {ModelId: "GPT-5.6-SOL"}, {ModelId: "Claude-Sonnet-4.5"}})
	for _, tc := range []struct{ in, want string }{
		{"gpt-5.6-sol", "gpt-5.6-sol"},
		{"GPT-5.6-Sol", "gpt-5.6-sol"},
		{"  gpt-5.6-sol  ", "gpt-5.6-sol"},
		{"claude-sonnet-4.5", "Claude-Sonnet-4.5"},
	} {
		got, ok := nativeModelID(tc.in)
		if !ok || got != tc.want {
			t.Errorf("nativeModelID(%q) = (%q, %v), want (%q, true)", tc.in, got, ok, tc.want)
		}
	}
	for _, miss := range []string{"", "  ", "gpt-5", "gpt-5.6", "vendor/gpt-5.6-sol"} {
		if got, ok := nativeModelID(miss); ok {
			t.Errorf("nativeModelID(%q) = %q, want no match", miss, got)
		}
	}

	publishNativeModels(nil)
	if _, ok := nativeModelID("gpt-5.6-sol"); ok {
		t.Fatal("publishNativeModels(nil) did not clear the set")
	}
	publishNativeModels([]ModelInfo{})
	if _, ok := nativeModelID("gpt-5.6-sol"); ok {
		t.Fatal("an empty model list left native models behind")
	}
}

func TestParseModelAndThinkingKeepsNativeModelOverSubstringRule(t *testing.T) {
	initDefaultMappingsConfig(t)
	seedNativeModels(t, "gpt-5.6-sol", "claude-opus-5", "claude-sonnet-4.5", "gpt-5.4-mini")

	for _, tc := range []struct {
		name, in, wantModel string
		wantThinking        bool
	}{
		{"native passes through", "gpt-5.6-sol", "gpt-5.6-sol", false},
		{"native with thinking suffix", "gpt-5.6-sol-thinking", "gpt-5.6-sol", true},
		{"native returns the listed spelling", "GPT-5.6-SOL", "gpt-5.6-sol", false},
		{"exact default rule still wins", "gpt-5", "claude-opus-5", false},
		{"exact default rule beats a native model", "gpt-5.4-mini", "claude-haiku-4.5", false},
		{"unlisted name still uses the substring rule", "gpt-5-unlisted", "claude-opus-5", false},
		{"prefixed native name is not native", "vendor/gpt-5.6-sol", "claude-opus-5", false},
		{"unlisted legacy name still maps", "gpt-3.5-turbo-0125", "claude-sonnet-5", false},
		{"claude dash version still normalises", "claude-opus-4-8", "claude-opus-4.8", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gotModel, gotThinking := ParseModelAndThinking(tc.in, "-thinking")
			if gotModel != tc.wantModel || gotThinking != tc.wantThinking {
				t.Fatalf("ParseModelAndThinking(%q) = (%q, %v), want (%q, %v)", tc.in, gotModel, gotThinking, tc.wantModel, tc.wantThinking)
			}
		})
	}
	if got := MapModel("gpt-5.6-sol"); got != "gpt-5.6-sol" {
		t.Fatalf("MapModel(gpt-5.6-sol) = %q, want gpt-5.6-sol", got)
	}
}

func TestParseModelAndThinkingWithoutNativeCacheKeepsSubstringMapping(t *testing.T) {
	initDefaultMappingsConfig(t)
	publishNativeModels(nil)
	t.Cleanup(func() { publishNativeModels(nil) })

	if got, thinking := ParseModelAndThinking("gpt-5.6-sol", "-thinking"); got != "claude-opus-5" || thinking {
		t.Fatalf("ParseModelAndThinking(gpt-5.6-sol) with no model list = (%q, %v), want (claude-opus-5, false)", got, thinking)
	}
}

func TestExactMappingBeatsNativeModel(t *testing.T) {
	initDefaultMappingsConfig(t)
	seedNativeModels(t, "gpt-5.6-sol", "claude-opus-5")
	if err := config.UpdateModelMappings([]config.ModelMappingRule{{Key: "GPT-5.6-sol", Value: "claude-opus-5"}}); err != nil {
		t.Fatalf("UpdateModelMappings: %v", err)
	}

	for _, in := range []string{"gpt-5.6-sol", "gpt-5.6-sol-thinking"} {
		got, thinking := ParseModelAndThinking(in, "-thinking")
		if got != "claude-opus-5" || thinking != strings.HasSuffix(in, "-thinking") {
			t.Fatalf("ParseModelAndThinking(%q) = (%q, %v), want claude-opus-5 from the exact rule", in, got, thinking)
		}
	}
}

func TestResolveClaudeThinkingModeKeepsNativeModel(t *testing.T) {
	initDefaultMappingsConfig(t)
	seedNativeModels(t, "gpt-5.6-sol")

	got, thinking := resolveClaudeThinkingMode("gpt-5.6-sol", &ClaudeThinkingConfig{Type: "adaptive"}, "-thinking")
	if got != "gpt-5.6-sol" || !thinking {
		t.Fatalf("resolveClaudeThinkingMode = (%q, %v), want (gpt-5.6-sol, true)", got, thinking)
	}
	got, thinking = resolveClaudeThinkingMode("gpt-5.6-sol-thinking", nil, "-thinking")
	if got != "gpt-5.6-sol" || !thinking {
		t.Fatalf("resolveClaudeThinkingMode suffix = (%q, %v), want (gpt-5.6-sol, true)", got, thinking)
	}
}

func TestTranslatorsKeepNativeModelID(t *testing.T) {
	initDefaultMappingsConfig(t)
	seedNativeModels(t, "gpt-5.6-sol")

	claude := ClaudeToKiro(&ClaudeRequest{
		Model:     "gpt-5.6-sol",
		MaxTokens: 16,
		Messages:  []ClaudeMessage{{Role: "user", Content: "hi"}},
	}, false)
	if got := claude.ConversationState.CurrentMessage.UserInputMessage.ModelID; got != "gpt-5.6-sol" {
		t.Fatalf("ClaudeToKiro modelId = %q, want gpt-5.6-sol", got)
	}

	openai := OpenAIToKiro(&OpenAIRequest{
		Model:    "gpt-5.6-sol",
		Messages: []OpenAIMessage{{Role: "user", Content: "hi"}},
	}, false)
	if got := openai.ConversationState.CurrentMessage.UserInputMessage.ModelID; got != "gpt-5.6-sol" {
		t.Fatalf("OpenAIToKiro modelId = %q, want gpt-5.6-sol", got)
	}
}

func TestNativeModelReachesUpstreamOnEveryEndpoint(t *testing.T) {
	var mu sync.Mutex
	var captured []string
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var payload KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode upstream payload: %v", err)
		}
		mu.Lock()
		captured = append(captured, payload.ConversationState.CurrentMessage.UserInputMessage.ModelID)
		mu.Unlock()
		writeKiroTextResponse(t, w, "ok")
	})
	t.Cleanup(func() { _ = config.UpdateModelMappings(config.DefaultModelMappings()) })
	h.pool.SetModelList("responses-account", []string{"gpt-5.6-sol"})
	t.Cleanup(func() { h.pool.SetModelList("responses-account", nil) })
	seedNativeModels(t, "gpt-5.6-sol")

	for _, tc := range []struct{ name, path, body string }{
		{"messages", "/v1/messages", `{"model":"gpt-5.6-sol","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`},
		{"chat", "/v1/chat/completions", `{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"hi"}]}`},
		{"responses", "/v1/responses", `{"model":"gpt-5.6-sol","input":"hi","store":false}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mu.Lock()
			captured = nil
			mu.Unlock()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body)))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			mu.Lock()
			defer mu.Unlock()
			if len(captured) == 0 {
				t.Fatal("upstream was not called")
			}
			for _, model := range captured {
				if model != "gpt-5.6-sol" {
					t.Fatalf("upstream modelId = %q, want gpt-5.6-sol", model)
				}
			}
		})
	}

	t.Run("count_tokens", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"model":"gpt-5.6-sol","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
	})
}

func TestModelsCacheWritesPublishNativeModels(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Errorf("inference endpoint called while listing models")
		w.WriteHeader(http.StatusInternalServerError)
	})
	t.Cleanup(func() { _ = config.UpdateModelMappings(config.DefaultModelMappings()) })
	t.Cleanup(func() { publishNativeModels(nil) })
	t.Cleanup(func() { h.pool.SetModelList("responses-account", nil) })
	stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "ListAvailableModels") {
			return jsonResponse(http.StatusOK, `{"models":[{"modelId":"gpt-5.6-sol"}]}`), nil
		}
		return jsonResponse(http.StatusNotFound, `{}`), nil
	})

	account := config.Account{
		ID:          "responses-account",
		Enabled:     true,
		AccessToken: "token-responses",
		ProfileArn:  "arn:aws:codewhisperer:us-east-1:123456789012:profile/responses",
	}
	for _, tc := range []struct {
		name string
		run  func(t *testing.T)
	}{
		{"fetchAndCacheAccountModels", func(t *testing.T) {
			if err := h.fetchAndCacheAccountModels(&account); err != nil {
				t.Fatalf("fetchAndCacheAccountModels: %v", err)
			}
		}},
		{"account models endpoint", func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.apiGetAccountModels(rec, httptest.NewRequest(http.MethodGet, "/", nil), "responses-account")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
			}
		}},
		{"full sweep", func(t *testing.T) { h.sweepModelsCache() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			publishNativeModels(nil)
			h.modelsCacheMu.Lock()
			h.cachedModels = nil
			h.modelsCacheMu.Unlock()

			tc.run(t)
			if got, ok := nativeModelID("gpt-5.6-sol"); !ok || got != "gpt-5.6-sol" {
				t.Fatalf("nativeModelID after %s = (%q, %v), want (gpt-5.6-sol, true)", tc.name, got, ok)
			}
			if got := MapModel("gpt-5.6-sol"); got != "gpt-5.6-sol" {
				t.Fatalf("MapModel(gpt-5.6-sol) = %q, want gpt-5.6-sol", got)
			}
		})
	}
}

func TestListModelsForHousekeepingRetriesWhileAnAccountFails(t *testing.T) {
	publishNativeModels(nil)
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Errorf("inference endpoint called while listing models")
		w.WriteHeader(http.StatusInternalServerError)
	})
	t.Cleanup(func() { publishNativeModels(nil) })
	if err := config.AddAccount(config.Account{ID: "pro-account", Enabled: true, AccessToken: "token-pro", ProfileArn: "arn:aws:codewhisperer:profile/pro"}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	h.pool.Reload()
	t.Cleanup(func() {
		h.pool.SetModelList("responses-account", nil)
		h.pool.SetModelList("pro-account", nil)
	})
	var proDown atomic.Bool
	proDown.Store(true)
	stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
		if !strings.Contains(r.URL.Path, "ListAvailableModels") {
			return jsonResponse(http.StatusNotFound, `{}`), nil
		}
		if strings.Contains(r.Header.Get("Authorization"), "token-pro") {
			if proDown.Load() {
				return jsonResponse(http.StatusInternalServerError, `{}`), nil
			}
			return jsonResponse(http.StatusOK, `{"models":[{"modelId":"gpt-5.6-sol"}]}`), nil
		}
		return jsonResponse(http.StatusOK, `{"models":[{"modelId":"claude-sonnet-4.5"}]}`), nil
	})

	//! One account listed, so the cache is not empty, but the failed one still needs a retry.
	if !h.listModelsForHousekeeping() {
		t.Fatal("a listing with a failed account must ask for a retry")
	}
	if _, ok := nativeModelID("claude-sonnet-4.5"); !ok {
		t.Fatal("the account that listed is missing from the native set")
	}
	if _, ok := nativeModelID("gpt-5.6-sol"); ok {
		t.Fatal("gpt-5.6-sol is native before the account that lists it answered")
	}

	proDown.Store(false)
	if h.listModelsForHousekeeping() {
		t.Fatal("a listing with no failed account asked for a retry")
	}
	if got := MapModel("gpt-5.6-sol"); got != "gpt-5.6-sol" {
		t.Fatalf("MapModel(gpt-5.6-sol) after the retry = %q, want gpt-5.6-sol", got)
	}
}
