package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenAIWebSearchOptionsParse(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		on       bool
		results  int
		location string
	}{
		{"absent", `{}`, false, 0, ""},
		{"null", `{"web_search_options":null}`, false, 0, ""},
		{"empty object", `{"web_search_options":{}}`, true, 0, ""},
		{"low", `{"web_search_options":{"search_context_size":"low"}}`, true, 3, ""},
		{"medium", `{"web_search_options":{"search_context_size":"medium"}}`, true, 5, ""},
		{"high", `{"web_search_options":{"search_context_size":"HIGH"}}`, true, 10, ""},
		{"OpenAI location", `{"web_search_options":{"user_location":{"type":"approximate","approximate":{"city":"London","region":"England","country":"GB","timezone":"Europe/London"}}}}`, true, 0, "London, England, GB (time zone Europe/London)"},
		{"flat location", `{"web_search_options":{"user_location":{"type":"approximate","city":"Austin","country":"US"}}}`, true, 0, "Austin, US"},
		{"time zone only", `{"web_search_options":{"user_location":{"type":"approximate","approximate":{"timezone":"Asia/Tokyo"}}}}`, true, 0, "time zone Asia/Tokyo"},
		{"null location", `{"web_search_options":{"user_location":null}}`, true, 0, ""},
		// Values the proxy cannot use are ignored, never a 400.
		{"unknown size", `{"web_search_options":{"search_context_size":"huge"}}`, true, 0, ""},
		{"wrong types", `{"web_search_options":{"search_context_size":5,"user_location":"London","filters":{"allowed_domains":["go.dev"]}}}`, true, 0, ""},
		{"wrong field types", `{"web_search_options":{"user_location":{"approximate":{"city":7,"country":"FR"}}}}`, true, 0, "FR"},
		{"not an object", `{"web_search_options":true}`, false, 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req OpenAIRequest
			if err := json.Unmarshal([]byte(tc.body), &req); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			got := OpenAIWebSearchOptions{}
			if req.WebSearchOptions != nil {
				got = *req.WebSearchOptions
			}
			if got.on != tc.on || got.results != tc.results || got.location != tc.location {
				t.Fatalf("got on=%v results=%d location=%q, want on=%v results=%d location=%q", got.on, got.results, got.location, tc.on, tc.results, tc.location)
			}
		})
	}
}

func TestOpenAIWebSearchOptionsCapLocationFields(t *testing.T) {
	long := strings.Repeat("x", 500)
	var req OpenAIRequest
	if err := json.Unmarshal([]byte(`{"web_search_options":{"user_location":{"approximate":{"city":"`+long+`","region":"a\n  b"}}}}`), &req); err != nil {
		t.Fatal(err)
	}
	want := strings.Repeat("x", maxWebSearchLocationField) + ", a b"
	if got := req.WebSearchOptions.location; got != want {
		t.Fatalf("location = %q, want %q", got, want)
	}
}

// webSearchTools returns the hosted search tools a Kiro payload declares.
func webSearchTools(payload *KiroPayload) []KiroToolWrapper {
	var found []KiroToolWrapper
	if ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext; ctx != nil {
		for _, tool := range ctx.Tools {
			if tool.ToolSpecification.Name == kiroWebSearchToolName {
				found = append(found, tool)
			}
		}
	}
	return found
}

func TestChatWebSearchOptionsDeclareHostedSearch(t *testing.T) {
	cases := []struct {
		name, extra string
		results     int
		functions   int
	}{
		{"options alone", `"web_search_options":{"search_context_size":"low","user_location":{"type":"approximate","approximate":{"city":"Paris","country":"FR"}}}`, 3, 0},
		{"with the tools form", `"tools":[{"type":"web_search"}],"web_search_options":{"search_context_size":"low","user_location":{"type":"approximate","approximate":{"city":"Paris","country":"FR"}}}`, 3, 0},
		{"with function tools", `"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],"web_search_options":{"search_context_size":"low","user_location":{"type":"approximate","approximate":{"city":"Paris","country":"FR"}}}`, 3, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req OpenAIRequest
			if err := json.Unmarshal([]byte(`{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"weather?"}],`+tc.extra+`}`), &req); err != nil {
				t.Fatal(err)
			}
			applyChatWebSearchOptions(&req)
			if msg := validateOpenAIRequestShape(&req); msg != "" {
				t.Fatalf("validate: %s", msg)
			}
			payload := OpenAIToKiro(&req, false)
			if !payload.HostedSearchTools[webSearchToolName] || payload.HostedSearchResults != tc.results {
				t.Fatalf("hosted tools %v results %d, want web_search keeping %d", payload.HostedSearchTools, payload.HostedSearchResults, tc.results)
			}
			search := webSearchTools(payload)
			if len(search) != 1 {
				t.Fatalf("declared %d hosted search tools, want 1", len(search))
			}
			if desc := search[0].ToolSpecification.Description; !strings.Contains(desc, "approximately in Paris, FR.") {
				t.Fatalf("description = %q, want the user's location", desc)
			}
			tools := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext.Tools
			if len(tools) != 1+tc.functions {
				t.Fatalf("declared %d tools, want %d", len(tools), 1+tc.functions)
			}
		})
	}

	t.Run("off", func(t *testing.T) {
		for _, body := range []string{`{}`, `{"web_search_options":null}`, `{"web_search_options":"auto"}`} {
			var req OpenAIRequest
			if err := json.Unmarshal([]byte(body), &req); err != nil {
				t.Fatal(err)
			}
			req.Messages = []OpenAIMessage{{Role: "user", Content: "hi"}}
			applyChatWebSearchOptions(&req)
			payload := OpenAIToKiro(&req, false)
			if len(req.Tools) != 0 || len(payload.HostedSearchTools) != 0 || len(webSearchTools(payload)) != 0 {
				t.Fatalf("%s turned search on: tools %v", body, req.Tools)
			}
		}
	})

	t.Run("tools form keeps its defaults", func(t *testing.T) {
		req := OpenAIRequest{Model: "claude-sonnet-4.5", Messages: []OpenAIMessage{{Role: "user", Content: "hi"}}, Tools: []OpenAITool{{Type: "web_search"}}}
		applyChatWebSearchOptions(&req)
		payload := OpenAIToKiro(&req, false)
		search := webSearchTools(payload)
		if payload.HostedSearchResults != 0 || len(search) != 1 || search[0].ToolSpecification.Description != "Search the web for current information." {
			t.Fatalf("results %d tools %+v, want the plain hosted tool", payload.HostedSearchResults, search)
		}
	})
}

// mcpTenResults is an MCP answer with ten results, as many as Kiro's search returns.
func mcpTenResults() string {
	var results []string
	for i := 1; i <= 10; i++ {
		results = append(results, fmt.Sprintf(`{"title":"Result %d","url":"https://r%d.example/","snippet":"Snippet %d"}`, i, i, i))
	}
	text, _ := json.Marshal(`{"results":[` + strings.Join(results, ",") + `]}`)
	return `{"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":` + string(text) + `}]}}`
}

func TestChatWebSearchOptionsContextSizeSetsResultsKept(t *testing.T) {
	cases := []struct {
		options string
		kept    int
	}{
		{`{"search_context_size":"low"}`, 3},
		{`{}`, 5},
		{`{"search_context_size":"medium"}`, 5},
		{`{"search_context_size":"high"}`, 10},
	}
	for _, tc := range cases {
		t.Run(tc.options, func(t *testing.T) {
			var bodies []string
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				bodies = append(bodies, string(body))
				if len(bodies) == 1 {
					writeFrames(w,
						awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "tooluse_ws1", "name": kiroWebSearchToolName, "input": `{"query":"results"}`, "stop": true}),
						awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.01}),
					)
					return
				}
				writeFrames(w,
					awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Done."}),
					awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.01}),
				)
			})
			stubMCPWebSearch(t, http.StatusOK, mcpTenResults())

			body := `{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"search"}],"web_search_options":` + tc.options + `}`
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body)))
			if rec.Code != http.StatusOK || len(bodies) != 2 {
				t.Fatalf("status=%d rounds=%d body=%s", rec.Code, len(bodies), rec.Body.String())
			}
			followup := bodies[1]
			for i := 1; i <= 10; i++ {
				url := fmt.Sprintf("https://r%d.example/", i)
				if got, want := strings.Contains(followup, url), i <= tc.kept; got != want {
					t.Fatalf("result %d in the follow-up = %v, want %v (keep %d)", i, got, want, tc.kept)
				}
			}
		})
	}
}
