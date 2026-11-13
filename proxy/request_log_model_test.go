package proxy

import (
	"net/http"
	"testing"

	"kiro-proxy/config"
)

func TestClassifyRequestErrorClientMistakes(t *testing.T) {
	cases := []struct {
		status  int
		message string
		want    string
	}{
		{404, `model "claude-opus-5.5" is not available on any account`, "invalid_request"},
		{404, `model "claude-opus-5.5" is not available on any account this API key can use`, "invalid_request"},
		{429, "API key call limit reached: 2 of 2 successful calls used", "api_key_limit"},
		{429, "API key call limit reached: 1 of 2 successful calls used, 1 more in progress", "api_key_limit"},
	}
	for _, tc := range cases {
		if got := classifyRequestError(false, tc.status, tc.message); got != tc.want {
			t.Fatalf("classifyRequestError(%d, %q) = %q, want %q", tc.status, tc.message, got, tc.want)
		}
	}
}

// A request refused by validation logs the model it would have run on, the same name a
// successful request logs, not the client's alias.
func TestValidationFailureLogsMappedModel(t *testing.T) {
	h := newKeyAccessHandler(t, recordingUpstream(t, &servedBy{}), "free-a")
	if err := config.UpdateModelMappings(append(config.GetModelMappings(), config.ModelMappingRule{Key: "claude-sonnet-5-5", Value: "claude-sonnet-4.5"})); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ path, body string }{
		{"/v1/messages", `{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[]}`},
		{"/v1/chat/completions", `{"model":"claude-sonnet-5-5","messages":[]}`},
		{"/v1/responses", `{"model":"claude-sonnet-5-5","input":[]}`},
	} {
		rec := serveWithKey(h, http.MethodPost, tc.path, "", tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d body=%s", tc.path, rec.Code, rec.Body.String())
		}
		if got := getObserveStore().RecentRequests(1); len(got) != 1 || got[0].Model != "claude-sonnet-4.5" {
			t.Fatalf("%s: logged %+v, want model claude-sonnet-4.5", tc.path, got)
		}
	}
}

// A request refused at authentication (here a used-up call limit) still names its model.
func TestKeyLimitRefusalLogsTheModel(t *testing.T) {
	h := newKeyAccessHandler(t, recordingUpstream(t, &servedBy{}), "free-a")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-call-limit-model", CallLimit: 1})
	requireKeys(t)
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("first call: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ path, body string }{
		{"/v1/messages", boundKeyClaudeBody},
		{"/v1/chat/completions", boundKeyOpenAIBody},
	} {
		rec := serveWithKey(h, http.MethodPost, tc.path, key.Key, tc.body)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("%s: status=%d", tc.path, rec.Code)
		}
		got := getObserveStore().RecentRequests(1)
		if len(got) != 1 || got[0].Model == "" || got[0].Model != requestLogModel(got[0].Model) {
			t.Fatalf("%s: logged %+v, want the request's model", tc.path, got)
		}
	}
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", "sk-wrong-key-123456", `{"model":"claude-haiku-4.5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key: %d", rec.Code)
	}
	if got := getObserveStore().RecentRequests(1); len(got) != 1 || got[0].Model != "claude-haiku-4.5" {
		t.Fatalf("wrong key: logged %+v, want claude-haiku-4.5", got)
	}
}
