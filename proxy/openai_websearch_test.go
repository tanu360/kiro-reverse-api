package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Recorded live (scrubbed): the MCP answer to "go blog latest", cut to two results.
const mcpGoBlogResults = `{"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"{\"results\":[{\"title\":\"Go 1.27 is released\",\"url\":\"https://go.dev/blog/go1.27\",\"snippet\":\"The Go team is happy to announce Go 1.27.\",\"publishedDate\":1786492800000},{\"title\":\"The Go Blog\",\"url\":\"https://go.dev/blog/\",\"snippet\":\"Index of posts\"}]}"}]}}`

const (
	goBlogSaid   = "Let me check the Go blog:"
	goBlogAnswer = "Go 1.27 is out: [Go 1.27 is released](https://go.dev/blog/go1.27)."
	goBlogLink   = "[Go 1.27 is released](https://go.dev/blog/go1.27)"
	// The rounds' contextUsagePercentage: 4000 and 6000 tokens of a 200K window.
	goBlogRound1Pct = 2.0
	goBlogRound2Pct = 3.0
)

// goBlogUpstream is a reply that says a sentence, searches once, then answers citing a result.
func goBlogUpstream(t *testing.T, calls *int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		*calls++
		if *calls == 1 {
			writeFrames(w,
				awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": goBlogSaid}),
				awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "tooluse_ws1", "name": kiroWebSearchToolName, "input": `{"query":"go blog latest"}`, "stop": true}),
				awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": goBlogRound1Pct}),
				awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.01}),
			)
			return
		}
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": goBlogAnswer}),
			awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": goBlogRound2Pct}),
			awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.02}),
		)
	}
}

type sseEvent struct {
	name string
	data map[string]interface{}
}

func readSSEEvents(t *testing.T, body []byte) []sseEvent {
	t.Helper()
	var events []sseEvent
	name := ""
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			raw := strings.TrimPrefix(line, "data: ")
			if raw == "[DONE]" {
				continue
			}
			var data map[string]interface{}
			if err := json.Unmarshal([]byte(raw), &data); err != nil {
				t.Fatalf("decode %q: %v", raw, err)
			}
			events = append(events, sseEvent{name: name, data: data})
			name = ""
		}
	}
	return events
}

func runeSpan(text, part string) (int, int) {
	i := strings.Index(text, part)
	if i < 0 {
		return -1, -1
	}
	start := len([]rune(text[:i]))
	return start, start + len([]rune(part))
}

func TestSearchCitations(t *testing.T) {
	searches := []*hostedWebSearch{
		{id: "ws_1", query: "go", done: true, results: []WebSearchResult{{Title: "Go 1.27 is released", URL: "https://go.dev/blog/go1.27"}, {Title: "The Go Blog", URL: "https://go.dev/blog/"}}},
		{id: "ws_2", query: "down", done: true, err: errors.New("MCP HTTP 500"), results: []WebSearchResult{{Title: "never", URL: "https://example.com"}}},
	}
	text := "Go 1.27 — see [the post](https://go.dev/blog/go1.27). Index: https://go.dev/blog. Not https://go.dev/blog/go1.27beta or https://example.com."
	got := searchCitations(text, searches)
	if len(got) != 2 {
		t.Fatalf("citations = %+v, want the link and the bare index URL", got)
	}
	runes := []rune(text)
	if part := string(runes[got[0].start:got[0].end]); part != "[the post](https://go.dev/blog/go1.27)" || got[0].title != "Go 1.27 is released" || got[0].url != "https://go.dev/blog/go1.27" {
		t.Fatalf("first citation covers %q (%+v), want the whole markdown link", part, got[0])
	}
	if part := string(runes[got[1].start:got[1].end]); part != "https://go.dev/blog" || got[1].url != "https://go.dev/blog/" || got[1].title != "The Go Blog" {
		t.Fatalf("second citation covers %q (%+v), want the index URL without its slash", part, got[1])
	}
}

func TestResponsesStreamReportsHostedSearchAsWebSearchCall(t *testing.T) {
	calls := 0
	h := newStreamTestHandler(t, goBlogUpstream(t, &calls))
	stubMCPWebSearch(t, http.StatusOK, mcpGoBlogResults)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","stream":true,"store":false,
		"input":"What is new on the Go blog?","tools":[{"type":"web_search"}],"include":["web_search_call.action.sources"]}`)))
	if rec.Code != http.StatusOK || calls != 2 {
		t.Fatalf("status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
	}
	events := readSSEEvents(t, rec.Body.Bytes())

	var order []string
	var searchID string
	var completed map[string]interface{}
	var annotations []interface{}
	texts := map[string]string{}
	for _, e := range events {
		switch e.name {
		case "response.output_item.added":
			item := e.data["item"].(map[string]interface{})
			order = append(order, "added:"+item["type"].(string))
			if item["type"] == "web_search_call" {
				searchID = item["id"].(string)
				action := item["action"].(map[string]interface{})
				if item["status"] != "in_progress" || action["type"] != "search" || action["query"] != "go blog latest" {
					t.Fatalf("added web_search_call = %v", item)
				}
			}
		case "response.output_item.done":
			item := e.data["item"].(map[string]interface{})
			order = append(order, "done:"+item["type"].(string))
		case "response.web_search_call.in_progress", "response.web_search_call.searching", "response.web_search_call.completed":
			if e.data["item_id"] != searchID || e.data["output_index"] != float64(1) {
				t.Fatalf("%s = %v, want item %s at output 1", e.name, e.data, searchID)
			}
			order = append(order, strings.TrimPrefix(e.name, "response.web_search_call."))
		case "response.output_text.done":
			texts[e.data["item_id"].(string)] = e.data["text"].(string)
		case "response.output_text.annotation.added":
			annotations = append(annotations, e.data["annotation"])
		case "response.completed":
			completed = e.data["response"].(map[string]interface{})
		}
	}
	want := "added:message,done:message,added:web_search_call,in_progress,searching,completed,done:web_search_call,added:message,done:message"
	if got := strings.Join(order, ","); got != want {
		t.Fatalf("item events = %s\nwant %s", got, want)
	}
	if completed == nil {
		t.Fatalf("no response.completed: %s", rec.Body.String())
	}
	output := completed["output"].([]interface{})
	if len(output) != 3 {
		t.Fatalf("output = %v", output)
	}
	first, search, last := output[0].(map[string]interface{}), output[1].(map[string]interface{}), output[2].(map[string]interface{})
	if text := texts[first["id"].(string)]; text != goBlogSaid {
		t.Fatalf("first message = %q, want the text before the search", text)
	}
	if text := texts[last["id"].(string)]; text != goBlogAnswer {
		t.Fatalf("last message = %q, want the answer without the blank line that parts the rounds", text)
	}
	action := search["action"].(map[string]interface{})
	sources, _ := action["sources"].([]interface{})
	if search["status"] != "completed" || search["id"] != searchID || len(sources) != 2 || sources[0].(map[string]interface{})["url"] != "https://go.dev/blog/go1.27" {
		t.Fatalf("web_search_call = %v", search)
	}
	start, end := runeSpan(goBlogAnswer, goBlogLink)
	if len(annotations) != 1 {
		t.Fatalf("annotations = %v", annotations)
	}
	a := annotations[0].(map[string]interface{})
	if a["type"] != "url_citation" || a["url"] != "https://go.dev/blog/go1.27" || a["title"] != "Go 1.27 is released" || a["start_index"] != float64(start) || a["end_index"] != float64(end) {
		t.Fatalf("annotation = %v, want [%d,%d)", a, start, end)
	}
	lastParts := last["content"].([]interface{})
	if got := lastParts[0].(map[string]interface{})["annotations"].([]interface{}); len(got) != 1 {
		t.Fatalf("completed message annotations = %v", got)
	}
	if completed["output_text"] != goBlogSaid+"\n\n"+goBlogAnswer {
		t.Fatalf("output_text = %q", completed["output_text"])
	}
	assertBothRoundsCounted(t, completed["usage"].(map[string]interface{})["input_tokens"].(float64))
}

// assertBothRoundsCounted checks a reply's input covers both rounds' prompts (4000 and 6000
// context tokens, less their short answers), not just the last round's.
func assertBothRoundsCounted(t *testing.T, input float64) {
	t.Helper()
	if input < 9800 || input > 10000 {
		t.Fatalf("input tokens = %v, want both search rounds (about 10000), not only the last (about 6000)", input)
	}
}

func TestResponsesHostedSearchBufferedOutput(t *testing.T) {
	calls := 0
	h := newStreamTestHandler(t, goBlogUpstream(t, &calls))
	stubMCPWebSearch(t, http.StatusOK, mcpGoBlogResults)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","store":false,
		"input":"What is new on the Go blog?","tools":[{"type":"web_search"}]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Output []struct {
			Type    string                 `json:"type"`
			Status  string                 `json:"status"`
			Action  map[string]interface{} `json:"action"`
			Content []struct {
				Text        string                   `json:"text"`
				Annotations []map[string]interface{} `json:"annotations"`
			} `json:"content"`
		} `json:"output"`
		OutputText string                 `json:"output_text"`
		Usage      map[string]interface{} `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, item := range resp.Output {
		types = append(types, item.Type)
	}
	if got := strings.Join(types, ","); got != "message,web_search_call,message" {
		t.Fatalf("output types = %s body=%s", got, rec.Body.String())
	}
	if resp.Output[0].Content[0].Text != goBlogSaid || resp.Output[2].Content[0].Text != goBlogAnswer {
		t.Fatalf("messages = %q, %q", resp.Output[0].Content[0].Text, resp.Output[2].Content[0].Text)
	}
	if resp.Output[1].Status != "completed" || resp.Output[1].Action["query"] != "go blog latest" {
		t.Fatalf("web_search_call = %+v", resp.Output[1])
	}
	if _, listed := resp.Output[1].Action["sources"]; listed {
		t.Fatal("sources are listed only when include asks for them")
	}
	start, end := runeSpan(goBlogAnswer, goBlogLink)
	if a := resp.Output[2].Content[0].Annotations; len(a) != 1 || a[0]["start_index"] != float64(start) || a[0]["end_index"] != float64(end) {
		t.Fatalf("annotations = %v", a)
	}
	assertBothRoundsCounted(t, resp.Usage["input_tokens"].(float64))
}

func TestChatHostedSearchCitesResultsAndLogsEveryRound(t *testing.T) {
	for _, stream := range []bool{false, true} {
		name := "buffered"
		if stream {
			name = "stream"
		}
		t.Run(name, func(t *testing.T) {
			calls := 0
			h := newStreamTestHandler(t, goBlogUpstream(t, &calls))
			stubMCPWebSearch(t, http.StatusOK, mcpGoBlogResults)

			body := `{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"What is new on the Go blog?"}],"tools":[{"type":"web_search"}]`
			if stream {
				body += `,"stream":true,"stream_options":{"include_usage":true}`
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body+"}")))
			if rec.Code != http.StatusOK || calls != 2 {
				t.Fatalf("status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
			}

			content := ""
			var annotations []interface{}
			var input float64
			if stream {
				for _, e := range readSSEEvents(t, rec.Body.Bytes()) {
					if usage, ok := e.data["usage"].(map[string]interface{}); ok {
						input = usage["prompt_tokens"].(float64)
					}
					choices, _ := e.data["choices"].([]interface{})
					if len(choices) == 0 {
						continue
					}
					delta := choices[0].(map[string]interface{})["delta"].(map[string]interface{})
					if text, ok := delta["content"].(string); ok {
						content += text
					}
					if a, ok := delta["annotations"].([]interface{}); ok {
						annotations = append(annotations, a...)
					}
				}
			} else {
				var resp map[string]interface{}
				if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
					t.Fatal(err)
				}
				message := resp["choices"].([]interface{})[0].(map[string]interface{})["message"].(map[string]interface{})
				content = message["content"].(string)
				annotations, _ = message["annotations"].([]interface{})
				input = resp["usage"].(map[string]interface{})["prompt_tokens"].(float64)
			}
			if content != goBlogSaid+"\n\n"+goBlogAnswer {
				t.Fatalf("content = %q", content)
			}
			start, end := runeSpan(content, goBlogLink)
			if len(annotations) != 1 {
				t.Fatalf("annotations = %v body=%s", annotations, rec.Body.String())
			}
			a := annotations[0].(map[string]interface{})
			cite := a["url_citation"].(map[string]interface{})
			if a["type"] != "url_citation" || cite["url"] != "https://go.dev/blog/go1.27" || cite["title"] != "Go 1.27 is released" || cite["start_index"] != float64(start) || cite["end_index"] != float64(end) {
				t.Fatalf("annotation = %v, want [%d,%d)", a, start, end)
			}
			assertBothRoundsCounted(t, input)

			rec0 := getObserveStore().RecentRequests(1)[0]
			if !rec0.Success || float64(rec0.InTokens) != input || rec0.Credits < 0.0299 || rec0.Credits > 0.0301 {
				t.Fatalf("logged request = in %d credits %v success %v, want in %v and both rounds' 0.03 credits", rec0.InTokens, rec0.Credits, rec0.Success, input)
			}
			var chain []string
			for _, attempt := range rec0.Attempts {
				if !attempt.Success || attempt.AccountID != "only" {
					t.Fatalf("attempt %+v, want a success on the account", attempt)
				}
				chain = append(chain, attempt.Endpoint)
			}
			if got := strings.Join(chain, ","); got != "test,web_search,test" {
				t.Fatalf("attempts = %s, want the first round, the search, then the answer", got)
			}
		})
	}
}

func TestHostedSearchFailureIsLoggedAndReportedFailed(t *testing.T) {
	calls := 0
	h := newStreamTestHandler(t, goBlogUpstream(t, &calls))
	stubMCPWebSearch(t, http.StatusInternalServerError, `{"message":"search backend down"}`)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","stream":true,"store":false,
		"input":"What is new on the Go blog?","tools":[{"type":"web_search"}]}`)))
	if rec.Code != http.StatusOK || calls != 2 {
		t.Fatalf("status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
	}
	var done map[string]interface{}
	for _, e := range readSSEEvents(t, rec.Body.Bytes()) {
		if e.name == "response.web_search_call.completed" {
			t.Fatal("a failed search must not report completed")
		}
		if e.name == "response.output_item.done" {
			if item := e.data["item"].(map[string]interface{}); item["type"] == "web_search_call" {
				done = item
			}
		}
	}
	if done == nil || done["status"] != "failed" {
		t.Fatalf("web_search_call done = %v", done)
	}
	attempts := lastRecordedAttempts(t)
	if len(attempts) != 3 {
		t.Fatalf("attempts = %+v", attempts)
	}
	search, answer := attempts[1], attempts[2]
	if search.Endpoint != attemptEndpointWebSearch || search.Success || !search.GaveUp || search.Status != http.StatusInternalServerError {
		t.Fatalf("search attempt = %+v, want a failed web_search that gave up", search)
	}
	if !answer.Success || answer.Endpoint != "test" || search.Failover {
		t.Fatalf("answer attempt = %+v (search failover %v), want the next round, not a failover", answer, search.Failover)
	}
}

func TestClaudeWebSearchLoopKeepsTextBeforeSearchAndCountsEveryRound(t *testing.T) {
	calls := 0
	h := newStreamTestHandler(t, goBlogUpstream(t, &calls))
	stubMCPWebSearch(t, http.StatusOK, mcpGoBlogResults)

	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":256,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"What is new on the Go blog?"}]}`))
	if got := strings.Join(contentTypes(msg), ","); got != "text,server_tool_use,web_search_tool_result,text" {
		t.Fatalf("content types = %s", got)
	}
	blocks := msg["content"].([]interface{})
	if text := blocks[0].(map[string]interface{})["text"]; text != goBlogSaid {
		t.Fatalf("first text = %q, want what the reply said before searching", text)
	}
	usage := msg["usage"].(map[string]interface{})
	assertBothRoundsCounted(t, usage["input_tokens"].(float64))
	if rec := getObserveStore().RecentRequests(1)[0]; float64(rec.InTokens) != usage["input_tokens"].(float64) || rec.Credits < 0.0299 {
		t.Fatalf("logged request = %+v", rec)
	}
}
