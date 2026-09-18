package proxy

import (
	"bytes"
	"encoding/json"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHostedSearchStreamsServerResults(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			calls := 0
			searches := 0
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var p KiroPayload
				if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
					t.Fatal(err)
				}
				if calls > 1 {
					ctx := p.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
					if ctx == nil || len(ctx.ToolResults) != 1 {
						t.Fatal("missing search result")
					}
				}
				if calls <= 2 {
					w.Write(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "ws", "name": "web_search", "input": `{"query":"test"}`, "stop": true}))
					return
				}
				writeKiroTextResponse(t, w, "answer after hosted searches")
			})
			h.pool.RecordSuccess("only")
			stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
				searches++
				if r.URL.Path != "/mcp" {
					t.Fatalf("path=%s", r.URL.Path)
				}
				return jsonResponse(200, `{"result":{"content":[{"type":"text","text":"{\"results\":[{\"title\":\"result\",\"url\":\"https://example.com\",\"snippet\":\"found\"}]}"}]}}`), nil
			})
			req := `{"model":"claude-sonnet-4.5","stream":true,"store":false,"input":"search","messages":[{"role":"user","content":"search"}],"tools":[{"type":"web_search"}]}`
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("POST", path, strings.NewReader(req)))
			if rec.Code != 200 || searches != 2 || calls != 3 || !strings.Contains(rec.Body.String(), "answer after hosted searches") {
				t.Fatalf("status=%d searches=%d calls=%d body=%s", rec.Code, searches, calls, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), `"name":"web_search"`) {
				t.Fatal("hosted tool escaped to client")
			}
		})
	}
}
func TestSearchFollowupPreservesPriorResultsWithoutMutation(t *testing.T) {
	base := testKiroPayload()
	base.ConversationState.History = []KiroHistoryMessage{{AssistantResponseMessage: &KiroAssistantResponseMessage{ToolUses: []KiroToolUse{{ToolUseID: "previous", Name: "read"}}}}}
	base.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext = &UserInputMessageContext{ToolResults: []KiroToolResult{{ToolUseID: "previous", Content: []KiroResultContent{{Text: "important previous result"}}, Status: "success"}}}
	before, _ := json.Marshal(base)
	next := buildWebSearchFollowupPayload(base, []KiroToolUse{{ToolUseID: "search", Name: "web_search"}}, []KiroToolResult{{ToolUseID: "search", Status: "success"}})
	after, _ := json.Marshal(base)
	if !bytes.Equal(before, after) {
		t.Fatal("base payload mutated")
	}
	encoded, _ := json.Marshal(next)
	if !bytes.Contains(encoded, []byte("important previous result")) {
		t.Fatal("previous result lost")
	}
	for i, msg := range next.ConversationState.History {
		if i < len(next.ConversationState.History)-1 && msg.AssistantResponseMessage != nil && len(msg.AssistantResponseMessage.ToolUses) > 0 {
			t.Fatal("stale structured tool use")
		}
	}
}
func TestAdminEndpointsRefreshExpiredTokens(t *testing.T) {
	for _, kind := range []string{"models", "get-overage", "set-overage"} {
		t.Run(kind, func(t *testing.T) {
			h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Fatal("inference unexpected") })
			acc := config.Account{ID: "expired", Enabled: true, AuthMethod: "idc", AccessToken: "stale", RefreshToken: "refresh", ClientID: "client", ClientSecret: "secret", ExpiresAt: 1, ProfileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test"}
			if err := config.AddAccount(acc); err != nil {
				t.Fatal(err)
			}
			refreshes := 0
			old := auth.SetGlobalAuthClientForTest(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				refreshes++
				return jsonResponse(200, `{"accessToken":"fresh","refreshToken":"rotated","expiresIn":3600}`), nil
			})})
			defer auth.SetGlobalAuthClientForTest(old)
			stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("Authorization") != "Bearer fresh" {
					t.Fatal("stale bearer")
				}
				return jsonResponse(200, `{"models":[]}`), nil
			})
			req := httptest.NewRequest("POST", "/", strings.NewReader(`{"enabled":true}`))
			rec := httptest.NewRecorder()
			switch kind {
			case "models":
				h.apiGetAccountModels(rec, req, acc.ID)
			case "get-overage":
				h.apiGetAccountOverage(rec, req, acc.ID)
			default:
				h.apiSetAccountOverage(rec, req, acc.ID)
			}
			if rec.Code != 200 || refreshes != 1 {
				t.Fatalf("status=%d refreshes=%d body=%s", rec.Code, refreshes, rec.Body.String())
			}
		})
	}
}

func TestClientOwnedSearchToolIsNotIntercepted(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "local", "name": "web_search", "input": `{"query":"test"}`, "stop": true}))
	})
	h.pool.RecordSuccess("only")
	stubRestTransport(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("client tool dispatched as hosted search")
		return nil, nil
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","stream":true,"store":false,"input":"search","tools":[{"type":"function","name":"web_search","parameters":{"type":"object"}}]}`)))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"name":"web_search"`) {
		t.Fatalf("client tool missing: %d %s", rec.Code, rec.Body.String())
	}
}

func TestNamespacedHostedSearchDoesNotHijackClientAlias(t *testing.T) {
	calls, searches := 0, 0
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		names := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext.Tools
		for _, tool := range names {
			name := tool.ToolSpecification.Name
			w.Write(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": name, "name": name, "input": `{"query":"test"}`, "stop": true}))
		}
	})
	h.pool.RecordSuccess("only")
	stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
		searches++
		return jsonResponse(200, `{"result":{"content":[{"type":"text","text":"{\"results\":[{\"title\":\"result\",\"url\":\"https://example.com\"}]}"}]}}`), nil
	})
	rec := httptest.NewRecorder()
	req := `{"model":"claude-sonnet-4.5","stream":true,"store":false,"input":"search","tools":[{"type":"namespace","name":"research","tools":[{"type":"web_search"}]},{"type":"function","name":"web-search","parameters":{"type":"object"}}]}`
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(req)))
	if rec.Code != 200 || searches != 1 || calls != 1 {
		t.Fatalf("status=%d searches=%d calls=%d body=%s", rec.Code, searches, calls, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"name":"web-search"`) {
		t.Fatal("client alias was hijacked")
	}
	if strings.Contains(rec.Body.String(), `"name":"research.web_search"`) || strings.Contains(rec.Body.String(), `"name":"web_search"`) {
		t.Fatal("namespaced hosted call escaped")
	}
}
