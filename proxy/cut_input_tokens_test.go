package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// cutTestChunks is the whole answer of the fake Kiro below; Kiro's context count of 2.0915%
// covers the prompt and all of it.
var cutTestChunks = []string{"1 2 3 4 5 6 7 8 9 10 ", "11 12 13 14 15 16 17 18 19 20 ", "21 22 23 24 25 26 27 28 29 30"}

// newCutTestHandler answers every turn with cutTestChunks and then Kiro's context count, all in
// one write, so the count is in hand before the limiter cancels. With hold set, the count waits
// until the client is gone, as when the cancel comes before Kiro's last events; a whole answer
// still gets it after a short wait.
func newCutTestHandler(t *testing.T, hold *atomic.Bool) *Handler {
	t.Helper()
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var answer, trailer []byte
		for _, chunk := range cutTestChunks {
			answer = append(answer, answerFrame(t, chunk)...)
		}
		trailer = append(awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": 2.0915}), meteringFrame(t)...)
		w.WriteHeader(http.StatusOK)
		if !hold.Load() {
			_, _ = w.Write(append(answer, trailer...))
			return
		}
		_, _ = w.Write(answer)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			return
		case <-time.After(3 * time.Second):
		}
		_, _ = w.Write(trailer)
	})
	h.promptOverheads = newPromptOverheads()
	return h
}

// cutTestInputTokens reads the input count an answer reports: usage.input_tokens or
// prompt_tokens, the last message_delta of a Messages stream, the usage chunk of a Chat
// stream, or the final response of a Responses stream.
func cutTestInputTokens(t *testing.T, api string, stream bool, body string) int {
	t.Helper()
	var usage map[string]interface{}
	switch {
	case !stream:
		var resp map[string]interface{}
		if err := json.Unmarshal([]byte(body), &resp); err != nil {
			t.Fatalf("decode %s: %v", body, err)
		}
		usage, _ = resp["usage"].(map[string]interface{})
	case api == "chat":
		for _, line := range strings.Split(body, "\n") {
			data, ok := strings.CutPrefix(line, "data: ")
			if !ok || data == "[DONE]" {
				continue
			}
			var chunk map[string]interface{}
			if err := json.Unmarshal([]byte(data), &chunk); err != nil {
				t.Fatalf("decode %s: %v", data, err)
			}
			if u, ok := chunk["usage"].(map[string]interface{}); ok {
				usage = u
			}
		}
	default:
		for _, event := range parseResponsesSSE(t, body) {
			switch event.Name {
			case "message_delta":
				usage, _ = event.Data["usage"].(map[string]interface{})
			case "response.completed", "response.incomplete":
				usage, _ = responseSSEMap(t, event.Data["response"])["usage"].(map[string]interface{})
			}
		}
	}
	for _, key := range []string{"input_tokens", "prompt_tokens"} {
		if n, ok := usage[key].(float64); ok {
			return int(n)
		}
	}
	t.Fatalf("%s stream=%t: no input count in %s", api, stream, body)
	return 0
}

type cutTestRequest struct {
	api, limit string
}

func (c cutTestRequest) post(t *testing.T, h *Handler, stream bool) (int, int) {
	t.Helper()
	flag := map[bool]string{true: "true", false: "false"}[stream]
	var path, body string
	switch c.api {
	case "messages":
		path, body = "/v1/messages", `{"model":"claude-haiku-4.5",`+c.limit+`,"stream":`+flag+`,"messages":[{"role":"user","content":"Count from 1 to 30."}]}`
	case "chat":
		path, body = "/v1/chat/completions", `{"model":"claude-haiku-4.5",`+c.limit+`"stream":`+flag+`,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Count from 1 to 30."}]}`
	default:
		path, body = "/v1/responses", `{"model":"claude-haiku-4.5",`+c.limit+`"stream":`+flag+`,"store":false,"input":"Count from 1 to 30."}`
	}
	rec := postOK(t, h, path, body)
	logged := getObserveStore().RecentRequests(1)
	if len(logged) == 0 {
		t.Fatalf("%s: nothing in the request log", path)
	}
	return cutTestInputTokens(t, c.api, stream, rec.Body.String()), logged[0].InTokens
}

// A cut answer reports the prompt as Kiro counts it, the same as the whole answer: the count
// no longer turns on whether Kiro's context event arrived before the cut (4151, 4174 or 22
// live for one prompt).
func TestCutAnswerReportsTheSameInputCountAsTheWholeAnswer(t *testing.T) {
	uncut := map[string]cutTestRequest{
		"messages":  {"messages", `"max_tokens":1024`},
		"chat":      {"chat", ``},
		"responses": {"responses", ``},
	}
	cuts := []cutTestRequest{
		{"messages", `"max_tokens":8`},
		{"messages", `"max_tokens":1024,"stop_sequences":["12"]`},
		{"chat", `"max_tokens":8,`},
		{"chat", `"stop":["12"],`},
		{"responses", `"max_output_tokens":16,`},
	}
	for _, held := range []bool{false, true} {
		for _, stream := range []bool{false, true} {
			var hold atomic.Bool
			h := newCutTestHandler(t, &hold)
			whole := map[string]int{}
			for api, req := range uncut {
				in, logged := req.post(t, h, stream)
				if in < 1000 || logged != in {
					t.Fatalf("%s stream=%t whole answer: input %d, logged %d; want Kiro's count, logged the same", api, stream, in, logged)
				}
				whole[api] = in
			}
			hold.Store(held)
			for _, req := range cuts {
				in, logged := req.post(t, h, stream)
				if in != whole[req.api] || logged != in {
					t.Errorf("%s %s stream=%t held=%t: input %d, logged %d; want %d as for the whole answer",
						req.api, req.limit, stream, held, in, logged, whole[req.api])
				}
			}
		}
	}
}

// Before any whole answer, a cut answer whose context event did arrive takes Kiro's count with
// the output past the cut removed too, so a later whole answer and a held cut agree with it.
func TestCutAnswerWithKiroCountRemovesTheUnsentOutput(t *testing.T) {
	for _, req := range []cutTestRequest{
		{"messages", `"max_tokens":1024,"stop_sequences":["12"]`},
		{"chat", `"max_tokens":8,`},
		{"responses", `"max_output_tokens":16,`},
	} {
		var hold atomic.Bool
		h := newCutTestHandler(t, &hold)
		in, logged := req.post(t, h, false)
		whole, _ := cutTestRequest{req.api, map[string]string{"messages": `"max_tokens":1024`}[req.api]}.post(t, h, false)
		hold.Store(true)
		held, _ := req.post(t, h, true)
		if in != whole || logged != in || held != whole {
			t.Errorf("%s %s: cut %d (logged %d), whole %d, held cut %d; want all equal", req.api, req.limit, in, logged, whole, held)
		}
	}
}

// The table is saved, so the first cut answer after a restart still reports Kiro's count.
func TestPromptOverheadsSurviveARestart(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	before := loadPromptOverheads()
	if in, _ := before.finalizeUsage("claude-haiku-4.5", outputCut{}, 0, 32, 22, 4183, 32); in != 4151 {
		t.Fatalf("whole answer: input %d, want 4151", in)
	}
	after := loadPromptOverheads()
	if in, _ := after.finalizeUsage("claude-haiku-4.5", outputCut{cut: true}, 0, 8, 22, 0, 8); in != 4151 {
		t.Fatalf("cut answer after a restart: input %d, want 4151", in)
	}
}

func TestPromptOverheadsPickTheNearestCountedPrompt(t *testing.T) {
	p := newPromptOverheads()
	p.record("claude-haiku-4.5", 4, 4104, false)
	p.record("claude-haiku-4.5", 3738, 7706, false)
	p.record("deepseek-3.2", 22, 3793, false)
	cases := []struct {
		model     string
		estimated int
		want      int
	}{
		{"claude-haiku-4.5", 30, 4130},   // nearest is the 4-token prompt
		{"claude-haiku-4.5", 3000, 6968}, // nearest is the 3738-token prompt
		{"CLAUDE-HAIKU-4.5", 4, 4104},    // model IDs ignore case
		{"deepseek-3.2", 22, 3793},
		{"claude-sonnet-4.5", 22, 3793}, // no count for this model: the nearest of any model
	}
	for _, c := range cases {
		if got := c.estimated + p.overhead(c.model, c.estimated); got != c.want {
			t.Errorf("%s %d: got %d, want %d", c.model, c.estimated, got, c.want)
		}
	}
	// A cut answer's count does not replace a whole answer's for the same prompt size.
	if p.record("claude-haiku-4.5", 4, 4200, true) {
		t.Error("a cut count replaced a whole count")
	}
	if got := 4 + p.overhead("claude-haiku-4.5", 4); got != 4104 {
		t.Errorf("after a cut count: got %d, want 4104", got)
	}
	// The oldest entry gives way once a model holds promptOverheadsPerModel sizes.
	for i := 0; i < promptOverheadsPerModel; i++ {
		p.record("claude-haiku-4.5", 10000+i, 14000+i, false)
	}
	if p.countedWhole("claude-haiku-4.5", 4) {
		t.Error("the oldest entry was kept past the limit")
	}
	var empty *promptOverheads
	if in, _ := empty.finalizeUsage("m", outputCut{cut: true}, 0, 8, 22, 0, 8); in != 22 {
		t.Errorf("no table: input %d, want the estimate 22", in)
	}
}
