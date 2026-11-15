package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
)

const testProfileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/TESTPROFILE"

func TestCreateResponseFeatureKey(t *testing.T) {
	//! sha256 hex of the salt and "create_response_api", as the Kiro IDE's deriveWireKey computes it.
	if createResponseFeatureKey != "8242f5d7e306898aef7ec21ccbe97fd8e9150efbe8f093b12c8dc8b7d46fb604" {
		t.Fatalf("key = %s", createResponseFeatureKey)
	}
}

func TestChatAPIFlagRequestForBuilderID(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	account := &config.Account{ID: "bid", AccessToken: "tok-bid", Provider: "BuilderId", AuthMethod: "idc", MachineId: "machine-1"}
	req, err := newChatAPIFlagRequest(account, "")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if req.Method != http.MethodGet || req.URL.Host != "runtime.us-east-1.kiro.dev" || req.URL.Path != "/featureConfiguration" {
		t.Fatalf("url = %s %s", req.Method, req.URL)
	}
	q := req.URL.Query()
	if q.Get("origin") != "AI_EDITOR" || q.Get("version") != config.GetKiroClientConfig().KiroVersion {
		t.Fatalf("query = %v", q)
	}
	for header, want := range map[string]string{
		"Authorization":           "Bearer tok-bid",
		"Accept":                  "application/json",
		"x-amzn-kiro-profile-arn": builderIDProfileArn,
	} {
		if got := req.Header.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	if ua := req.Header.Get("User-Agent"); !strings.Contains(ua, "KiroIDE-"+config.GetKiroClientConfig().KiroVersion+"-machine-1") {
		t.Fatalf("user agent = %q", ua)
	}

	//! The profile ARN's region picks the runtime.
	req, _ = newChatAPIFlagRequest(&config.Account{ID: "eu", AccessToken: "t"}, "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU")
	if req.URL.Host != "runtime.eu-central-1.kiro.dev" || req.Header.Get("x-amzn-kiro-profile-arn") == "" {
		t.Fatalf("eu request = %s %v", req.URL, req.Header)
	}
}

func TestFetchChatAPIFlag(t *testing.T) {
	respond := func(status int, body string) *http.Client {
		return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
		})}
	}
	req, _ := http.NewRequest(http.MethodGet, "https://runtime.us-east-1.kiro.dev/featureConfiguration", nil)
	cases := []struct {
		body   string
		status int
		want   bool
		err    bool
	}{
		{`{"configuration":{"` + createResponseFeatureKey + `":"create_response","other":"x"}}`, 200, true, false},
		{`{"configuration":{"a":"1","b":"2","c":"3"}}`, 200, false, false},
		{`{"configuration":{"` + createResponseFeatureKey + `":"control"}}`, 200, false, false},
		{`{"configuration":{"` + createResponseFeatureKey + `":{"value":1}}}`, 200, false, false},
		{`{"message":"profileArn is required"}`, 400, false, true},
		{`not json`, 200, false, true},
	}
	for _, tc := range cases {
		got, err := fetchChatAPIFlag(context.Background(), respond(tc.status, tc.body), req)
		if got != tc.want || (err != nil) != tc.err {
			t.Fatalf("%d %s: got %t, %v", tc.status, tc.body, got, err)
		}
	}
}

// stubChatAPIFlag replaces the flag read and the clock for one test.
type stubChatAPIFlag struct {
	mu      sync.Mutex
	answers []bool
	errs    []error
	calls   atomic.Int32
	now     time.Time
	gate    chan struct{}
	done    chan struct{}
}

func newStubChatAPIFlag(t *testing.T) *stubChatAPIFlag {
	t.Helper()
	s := &stubChatAPIFlag{now: time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC), done: make(chan struct{}, 16)}
	oldFetch, oldNow := chatAPIFlagFetch, chatAPIFlagNow
	chatAPIFlagFetch = func(context.Context, *http.Client, *http.Request) (bool, error) {
		n := int(s.calls.Add(1)) - 1
		if s.gate != nil {
			<-s.gate
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		defer func() { s.done <- struct{}{} }()
		var err error
		if n < len(s.errs) {
			err = s.errs[n]
		}
		answer := false
		if n < len(s.answers) {
			answer = s.answers[n]
		}
		return answer, err
	}
	chatAPIFlagNow = func() time.Time {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.now
	}
	t.Cleanup(func() { chatAPIFlagFetch, chatAPIFlagNow = oldFetch, oldNow })
	return s
}

func (s *stubChatAPIFlag) advance(d time.Duration) {
	s.mu.Lock()
	s.now = s.now.Add(d)
	s.mu.Unlock()
}

func (s *stubChatAPIFlag) waitBackground(t *testing.T) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("background flag read did not run")
	}
	//! finish runs right after the fetch returns; wait until it has stored the answer.
	chatAPIFlags.Range(func(key, _ interface{}) bool {
		waitChatAPIFlagIdle(t, key.(string))
		return true
	})
}

func flagTestAccount(t *testing.T, id string) *config.Account {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(func() {
		waitChatAPIFlagIdle(t, id)
		chatAPIFlags.Delete(id)
	})
	return &config.Account{ID: id, AccessToken: "tok-" + id, ProfileArn: testProfileArn}
}

// waitChatAPIFlagIdle waits for an account's background flag read to finish, so the test's
// stubs are not swapped back while it still uses them.
func waitChatAPIFlagIdle(t *testing.T, id string) {
	t.Helper()
	value, ok := chatAPIFlags.Load(id)
	if !ok {
		return
	}
	f := value.(*chatAPIFlag)
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		idle := f.call == nil
		f.mu.Unlock()
		if idle {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("background flag read did not finish")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestChatAPIFlagCacheAndBackoff(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.answers = []bool{true, false, false, false}
	stub.errs = []error{nil, errors.New("timeout"), nil}
	account := flagTestAccount(t, "flag-cache")
	ctx := context.Background()

	if !useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("first request must wait for the read and follow it")
	}
	stub.advance(14 * time.Minute)
	if !useKiroResponsesAPI(ctx, account, testProfileArn) || stub.calls.Load() != 1 {
		t.Fatalf("within 15 minutes the answer is cached; reads = %d", stub.calls.Load())
	}

	//! Stale: the last answer serves this request while a read runs in the background, and that read fails.
	stub.advance(2 * time.Minute)
	if !useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("a stale answer still serves")
	}
	stub.waitBackground(t)
	stub.advance(30 * time.Second)
	if !useKiroResponsesAPI(ctx, account, testProfileArn) || stub.calls.Load() != 2 {
		t.Fatalf("a failed read keeps the last good answer for a minute; reads = %d", stub.calls.Load())
	}

	//! A minute after the failure the next read runs; it says the account left the experiment.
	stub.advance(31 * time.Second)
	useKiroResponsesAPI(ctx, account, testProfileArn)
	stub.waitBackground(t)
	if useKiroResponsesAPI(ctx, account, testProfileArn) || stub.calls.Load() != 3 {
		t.Fatalf("the new answer applies; reads = %d", stub.calls.Load())
	}
}

func TestChatAPIFlagFailureWithoutAnswerUsesLegacy(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.errs = []error{errors.New("HTTP 400"), nil}
	stub.answers = []bool{false, true}
	account := flagTestAccount(t, "flag-fail")
	ctx := context.Background()

	if useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("no answer yet: generateAssistantResponse")
	}
	stub.advance(59 * time.Second)
	if useKiroResponsesAPI(ctx, account, testProfileArn) || stub.calls.Load() != 1 {
		t.Fatalf("no new read within a minute of a failure; reads = %d", stub.calls.Load())
	}
	//! After a failure the next read runs in the background: this request does not wait for it.
	stub.advance(2 * time.Second)
	if useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("the request after a failed read must not wait for the next one")
	}
	stub.waitBackground(t)
	stub.waitBackground(t)
	if !useKiroResponsesAPI(ctx, account, testProfileArn) || stub.calls.Load() != 2 {
		t.Fatalf("the background read's answer applies; reads = %d", stub.calls.Load())
	}
}

func TestChatAPIFlagSingleFlight(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.answers = []bool{true}
	stub.gate = make(chan struct{})
	account := flagTestAccount(t, "flag-single")

	var wg sync.WaitGroup
	results := make([]bool, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = readChatAPIFlag(context.Background(), account, testProfileArn, false)
		}(i)
	}
	time.Sleep(50 * time.Millisecond)
	close(stub.gate)
	wg.Wait()
	if stub.calls.Load() != 1 {
		t.Fatalf("reads = %d, want 1", stub.calls.Load())
	}
	for i, r := range results {
		if !r {
			t.Fatalf("caller %d got false", i)
		}
	}
}

func TestChatAPIFlagNewTokenKeepsAnswerAndRereads(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.answers = []bool{true, true}
	account := flagTestAccount(t, "flag-token")
	ctx := context.Background()
	useKiroResponsesAPI(ctx, account, testProfileArn)

	account.AccessToken = "tok-refreshed"
	if !useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("a refreshed token keeps the account's answer")
	}
	stub.waitBackground(t)
	stub.waitBackground(t)
	if stub.calls.Load() != 2 {
		t.Fatalf("a new token reads the flag again; reads = %d", stub.calls.Load())
	}
}

func TestChatAPIFlagRecheckBypassesCache(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.answers = []bool{false, true, false}
	account := flagTestAccount(t, "flag-recheck")
	ctx := context.Background()

	if useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("first read says control")
	}
	if !recheckKiroResponsesAPI(ctx, account, testProfileArn) || stub.calls.Load() != 2 {
		t.Fatalf("a recheck reads past the fresh cache; reads = %d", stub.calls.Load())
	}
	stub.advance(10 * time.Second)
	if !recheckKiroResponsesAPI(ctx, account, testProfileArn) || stub.calls.Load() != 2 {
		t.Fatalf("a second recheck within the gap uses the last read; reads = %d", stub.calls.Load())
	}
	if !useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("the rechecked answer is cached for later requests")
	}
}

func TestChatAPIModeOverridesFlag(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.answers = []bool{true}
	account := flagTestAccount(t, "flag-mode")
	ctx := context.Background()

	if err := config.UpdateChatAPI("legacy"); err != nil {
		t.Fatalf("set legacy: %v", err)
	}
	if useKiroResponsesAPI(ctx, account, testProfileArn) || recheckKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("legacy never uses CreateResponse")
	}
	if err := config.UpdateChatAPI("responses"); err != nil {
		t.Fatalf("set responses: %v", err)
	}
	if !useKiroResponsesAPI(ctx, account, testProfileArn) {
		t.Fatal("responses always uses CreateResponse")
	}
	if stub.calls.Load() != 0 {
		t.Fatalf("a forced mode reads no flag; reads = %d", stub.calls.Load())
	}
	apiKey := &config.Account{ID: "key", KiroApiKey: "ksk_x", AuthMethod: config.AuthMethodAPIKey}
	if useKiroResponsesAPI(ctx, apiKey, "") {
		t.Fatal("API keys stay on the Kiro CLI runtime")
	}
	if err := config.UpdateChatAPI("bogus"); !errors.Is(err, config.ErrInvalidChatAPI) {
		t.Fatalf("bogus mode: %v", err)
	}
	if err := config.UpdateChatAPI("AUTO"); err != nil || config.GetChatAPI() != config.ChatAPIAuto {
		t.Fatalf("auto: %v %q", err, config.GetChatAPI())
	}
}

func TestBuildKiroResponsesRequest(t *testing.T) {
	payload := &KiroPayload{ProfileArn: testProfileArn}
	state := &payload.ConversationState
	state.ConversationID = "conv-1"
	state.AgentContinuationId = "cont-1"
	payload.AdditionalModelRequestFields = map[string]interface{}{
		"output_config": map[string]interface{}{"effort": "high"},
		"thinking":      map[string]interface{}{"type": "adaptive", "display": "summarized", "budget_tokens": 4000},
	}
	toolResults := []KiroToolResult{{ToolUseID: "call_1", Content: []KiroResultContent{{Text: "line 1"}, {Text: "line 2"}}, Status: "success"}}
	thinking := thinkingOpenTag + "plan it" + thinkingCloseTag
	state.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{Content: "SYSTEM RULES\n\nhello", ModelID: "claude-sonnet-4.5", Origin: "AI_EDITOR"}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{
			Content:   thinking + "\n\nLet me look.",
			ToolUses:  []KiroToolUse{{ToolUseID: "call_1", Name: "read_file", Input: map[string]interface{}{"path": "a.go"}}},
			Reasoning: []KiroReasoningBlock{{Text: "plan it", Signature: "sig-1"}, {RedactedContent: "enc=="}},
		}},
		{UserInputMessage: &KiroUserInputMessage{
			Content:                 buildToolResultsContinuation(toolResults),
			UserInputMessageContext: &UserInputMessageContext{ToolResults: toolResults},
		}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: "Done."}},
	}
	current := &state.CurrentMessage.UserInputMessage
	current.Content = "What is in these?"
	current.ModelID = "claude-sonnet-4.5"
	current.Origin = "AI_EDITOR"
	current.Images = []KiroImage{{Format: "PNG"}}
	current.Images[0].Source.Bytes = "iVBORw0KGgo="
	current.Documents = []KiroDocument{{Format: "pdf", Name: "report"}}
	current.Documents[0].Source.Bytes = "JVBERi0="
	tool := KiroToolWrapper{}
	tool.ToolSpecification.Name = "read_file"
	tool.ToolSpecification.Description = "Read a file"
	tool.ToolSpecification.InputSchema.JSON = map[string]interface{}{"type": "object"}
	current.UserInputMessageContext = &UserInputMessageContext{Tools: []KiroToolWrapper{tool}}

	encoded, err := json.Marshal(buildKiroResponsesRequest(payload))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	wantJSON := `{
		"model": "claude-sonnet-4.5",
		"stream": true,
		"origin": "AI_EDITOR",
		"profileArn": "` + testProfileArn + `",
		"metadata": {"kiro:agent_mode": "vibe", "kiro:conversation_id": "conv-1", "kiro:agent_continuation_id": "cont-1"},
		"reasoning": {"type": "adaptive", "effort": "high", "summary": "summarized"},
		"tools": [{"type": "function", "name": "read_file", "description": "Read a file", "parameters": {"type": "object"}}],
		"input": [
			{"role": "user", "content": "SYSTEM RULES\n\nhello"},
			{"type": "reasoning", "summary": [], "encrypted_content": "{\"reasoningText\":{\"signature\":\"sig-1\",\"text\":\"plan it\"}}"},
			{"type": "reasoning", "summary": [], "encrypted_content": "{\"redactedContent\":\"enc==\"}"},
			{"role": "assistant", "content": "Let me look."},
			{"type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "{\"path\":\"a.go\"}"},
			{"type": "function_call_output", "call_id": "call_1", "output": "line 1\nline 2"},
			{"role": "assistant", "content": "Done."},
			{"role": "user", "content": [
				{"type": "input_text", "text": "What is in these?"},
				{"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="},
				{"type": "input_file", "filename": "report.pdf", "file_data": "data:application/pdf;base64,JVBERi0="}
			]}
		]
	}`
	var want map[string]interface{}
	if err := json.Unmarshal([]byte(wantJSON), &want); err != nil {
		t.Fatalf("want: %v", err)
	}
	gotPretty, _ := json.MarshalIndent(got, "", "  ")
	wantPretty, _ := json.MarshalIndent(want, "", "  ")
	if !bytes.Equal(gotPretty, wantPretty) {
		t.Fatalf("request body:\n%s\nwant:\n%s", gotPretty, wantPretty)
	}

	//! Without signed reasoning the thinking stays text, as generateAssistantResponse gets it.
	stripped := buildKiroResponsesRequestWithoutReasoning(payload)
	if replaysReasoning(stripped) {
		t.Fatal("stripped request still replays reasoning")
	}
	if stripped.Input[1]["content"] != thinking+"\n\nLet me look." {
		t.Fatalf("stripped assistant item = %v", stripped.Input[1])
	}
	if len(payload.ConversationState.History[1].AssistantResponseMessage.Reasoning) != 2 {
		t.Fatal("stripping must not change the caller's payload")
	}
}

func TestBuildKiroResponsesRequestKeepsUserTextBesideToolResults(t *testing.T) {
	payload := testKiroPayload()
	current := &payload.ConversationState.CurrentMessage.UserInputMessage
	current.Content = "Now fix it."
	current.UserInputMessageContext = &UserInputMessageContext{ToolResults: []KiroToolResult{{ToolUseID: "c1", Content: []KiroResultContent{{Text: "ok"}}}}}
	req := buildKiroResponsesRequest(payload)
	if len(req.Input) != 2 || req.Input[0]["type"] != "function_call_output" || req.Input[1]["content"] != "Now fix it." {
		t.Fatalf("input = %v", req.Input)
	}
	if req.Reasoning != nil || req.Tools != nil {
		t.Fatalf("reasoning = %v tools = %v", req.Reasoning, req.Tools)
	}

	current.Content = minimalFallbackUserContent
	if req := buildKiroResponsesRequest(payload); len(req.Input) != 1 {
		t.Fatalf("stand-in text beside tool results must go: %v", req.Input)
	}
}

func TestClaudeAssistantReasoning(t *testing.T) {
	content := []interface{}{
		map[string]interface{}{"type": "thinking", "thinking": "a", "signature": "s1"},
		map[string]interface{}{"type": "thinking", "thinking": "unsigned"},
		map[string]interface{}{"type": "redacted_thinking", "data": "enc"},
		map[string]interface{}{"type": "text", "text": "answer"},
	}
	got := claudeAssistantReasoning(content, true)
	if len(got) != 2 || got[0] != (KiroReasoningBlock{Text: "a", Signature: "s1"}) || got[1] != (KiroReasoningBlock{RedactedContent: "enc"}) {
		t.Fatalf("blocks = %+v", got)
	}
	if claudeAssistantReasoning(content, false) != nil {
		t.Fatal("thinking that is not replayed has no reasoning blocks")
	}
}

// chatAPITestUpstream answers generateAssistantResponse and CreateResponse calls.
type chatAPITestUpstream struct {
	mu        sync.Mutex
	legacy    int
	responses []*http.Request
	bodies    [][]byte
	legacyAns func() *http.Response
	respAns   func(n int) *http.Response
}

func (u *chatAPITestUpstream) install(t *testing.T) {
	t.Helper()
	old := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		u.mu.Lock()
		defer u.mu.Unlock()
		if req.URL.Path == "/v1/responses" {
			body, _ := io.ReadAll(req.Body)
			u.responses = append(u.responses, req)
			u.bodies = append(u.bodies, body)
			return u.respAns(len(u.responses)), nil
		}
		u.legacy++
		return u.legacyAns(), nil
	})})
	oldWait := streamRetryWait
	streamRetryWait = func(context.Context, time.Duration) error { return nil }
	t.Cleanup(func() {
		kiroHttpStore.Store(old)
		streamRetryWait = oldWait
	})
}

func httpAnswer(status int, contentType, body string) *http.Response {
	h := http.Header{}
	h.Set("Content-Type", contentType)
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}
}

func throttled429() *http.Response {
	return httpAnswer(429, "application/json", `{"message":"Too many requests, please wait before trying again.","reason":"USER_REQUEST_RATE_EXCEEDED"}`)
}

func TestCallKiroAPIRechecksFlagAfterRateLimit(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.answers = []bool{false, true}
	account := flagTestAccount(t, "recheck-call")
	account.MachineId = "machine-9"
	upstream := &chatAPITestUpstream{
		legacyAns: throttled429,
		respAns:   func(int) *http.Response { return httpAnswer(200, "text/event-stream", recordedResponsesText) },
	}
	upstream.install(t)

	var text string
	var credits float64
	err := CallKiroAPIContext(context.Background(), account, testKiroPayload(), &KiroStreamCallback{
		OnText:    func(s string, _ bool) { text += s },
		OnCredits: func(c float64) { credits = c },
	})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if text != "pong" || credits == 0 {
		t.Fatalf("text = %q credits = %v", text, credits)
	}
	if upstream.legacy != 1 || len(upstream.responses) != 1 || stub.calls.Load() != 2 {
		t.Fatalf("legacy = %d responses = %d flag reads = %d", upstream.legacy, len(upstream.responses), stub.calls.Load())
	}

	req := upstream.responses[0]
	if req.URL.String() != "https://runtime.us-east-1.kiro.dev/v1/responses" {
		t.Fatalf("url = %s", req.URL)
	}
	for header, want := range map[string]string{
		"Authorization":               "Bearer tok-recheck-call",
		"Content-Type":                "application/json",
		"x-amzn-kiro-origin":          "AI_EDITOR",
		"x-amzn-codewhisperer-optout": "true",
		"x-amzn-kiro-profile":         testProfileArn,
		"x-amzn-kiro-attempt":         "1;max=3",
		"User-Agent":                  "KiroIDE " + config.GetKiroClientConfig().KiroVersion + " machine-9 KAS/" + kiroAgentServiceVersion + " acp-client/kiro-ide",
		"X-Amz-Target":                "",
	} {
		if got := req.Header.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	var body map[string]interface{}
	if err := json.Unmarshal(upstream.bodies[0], &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["model"] != "claude-sonnet-4.5" || body["stream"] != true || body["profileArn"] != testProfileArn {
		t.Fatalf("body = %v", body)
	}

	//! The account stays on CreateResponse for its next request without another 429.
	text = ""
	if err := CallKiroAPIContext(context.Background(), account, testKiroPayload(), &KiroStreamCallback{OnText: func(s string, _ bool) { text += s }}); err != nil || text != "pong" {
		t.Fatalf("second call: %q %v", text, err)
	}
	if upstream.legacy != 1 || len(upstream.responses) != 2 {
		t.Fatalf("second call went to legacy = %d responses = %d", upstream.legacy, len(upstream.responses))
	}
}

func TestCallKiroAPIRateLimitStaysLegacyWhenFlagIsOff(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	account := flagTestAccount(t, "recheck-off")
	upstream := &chatAPITestUpstream{
		legacyAns: throttled429,
		respAns:   func(int) *http.Response { t.Fatal("CreateResponse must not be called"); return nil },
	}
	upstream.install(t)

	err := CallKiroAPIContext(context.Background(), account, testKiroPayload(), &KiroStreamCallback{})
	var q *upstreamQuotaError
	if !errors.As(err, &q) || !q.throttled {
		t.Fatalf("err = %v, want the throttle", err)
	}
	//! Every endpoint answered 429, but the flag is read again once per call.
	if upstream.legacy != len(endpointsForAccount(account)) || stub.calls.Load() != 2 {
		t.Fatalf("legacy = %d flag reads = %d", upstream.legacy, stub.calls.Load())
	}
}

func TestCallKiroAPIQuotaExhaustionDoesNotRecheck(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	stub.answers = []bool{false, true}
	account := flagTestAccount(t, "recheck-quota")
	upstream := &chatAPITestUpstream{
		legacyAns: func() *http.Response {
			return httpAnswer(429, "application/json", `{"message":"You have reached the limit.","reason":"MONTHLY_REQUEST_COUNT"}`)
		},
		respAns: func(int) *http.Response { t.Fatal("CreateResponse must not be called"); return nil },
	}
	upstream.install(t)

	err := CallKiroAPIContext(context.Background(), account, testKiroPayload(), &KiroStreamCallback{})
	var q *upstreamQuotaError
	if !errors.As(err, &q) || q.throttled || stub.calls.Load() != 1 {
		t.Fatalf("err = %v reads = %d", err, stub.calls.Load())
	}
}

func TestCallKiroAPIForcedResponsesMode(t *testing.T) {
	stub := newStubChatAPIFlag(t)
	account := flagTestAccount(t, "forced")
	if err := config.UpdateChatAPI("responses"); err != nil {
		t.Fatalf("set mode: %v", err)
	}
	upstream := &chatAPITestUpstream{
		legacyAns: func() *http.Response { t.Fatal("generateAssistantResponse must not be called"); return nil },
		respAns: func(n int) *http.Response {
			if n == 1 {
				//! A 200 that ends before any output is tried once more.
				return httpAnswer(200, "text/event-stream", "")
			}
			return httpAnswer(200, "text/event-stream", recordedResponsesToolCall)
		},
	}
	upstream.install(t)

	payload := testKiroPayload()
	payload.ToolNameMap = map[string]string{"getWeather": "get_weather"}
	var tools []KiroToolUse
	if err := CallKiroAPIContext(context.Background(), account, payload, &KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { tools = append(tools, tu) }}); err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "get_weather" || tools[0].Input["city"] != "Paris" {
		t.Fatalf("tools = %+v (the client's tool name comes back)", tools)
	}
	if len(upstream.responses) != 2 || upstream.responses[1].Header.Get("x-amzn-kiro-attempt") != "2;max=3" || stub.calls.Load() != 0 {
		t.Fatalf("responses = %d reads = %d", len(upstream.responses), stub.calls.Load())
	}
}

func TestCallKiroResponsesRetriesWithoutRejectedReasoning(t *testing.T) {
	newStubChatAPIFlag(t)
	account := flagTestAccount(t, "reasoning-fallback")
	if err := config.UpdateChatAPI("responses"); err != nil {
		t.Fatalf("set mode: %v", err)
	}
	upstream := &chatAPITestUpstream{
		legacyAns: func() *http.Response { t.Fatal("generateAssistantResponse must not be called"); return nil },
		respAns: func(n int) *http.Response {
			if n == 1 {
				return httpAnswer(400, "application/json", `{"error":{"message":"Invalid signature in thinking block","type":"invalid_request"}}`)
			}
			return httpAnswer(200, "text/event-stream", recordedResponsesText)
		},
	}
	upstream.install(t)

	payload := testKiroPayload()
	payload.ConversationState.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{Content: "hi"}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{
			Content:   thinkingOpenTag + "t" + thinkingCloseTag + "\n\nhello",
			Reasoning: []KiroReasoningBlock{{Text: "t", Signature: "foreign"}},
		}},
	}
	if err := CallKiroAPIContext(context.Background(), account, payload, &KiroStreamCallback{}); err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(upstream.bodies) != 2 || !bytes.Contains(upstream.bodies[0], []byte(`"type":"reasoning"`)) ||
		bytes.Contains(upstream.bodies[1], []byte(`"type":"reasoning"`)) {
		t.Fatalf("bodies:\n%s\n%s", upstream.bodies[0], upstream.bodies[1])
	}
	var retried kiroResponsesRequest
	if err := json.Unmarshal(upstream.bodies[1], &retried); err != nil || retried.Input[1]["content"] != thinkingOpenTag+"t"+thinkingCloseTag+"\n\nhello" {
		t.Fatalf("bodies:\n%s\n%s", upstream.bodies[0], upstream.bodies[1])
	}
}

func TestCallKiroResponsesThrottleFailsWithoutRetry(t *testing.T) {
	newStubChatAPIFlag(t)
	account := flagTestAccount(t, "responses-429")
	if err := config.UpdateChatAPI("responses"); err != nil {
		t.Fatalf("set mode: %v", err)
	}
	upstream := &chatAPITestUpstream{
		legacyAns: func() *http.Response { t.Fatal("generateAssistantResponse must not be called"); return nil },
		respAns: func(int) *http.Response {
			resp := httpAnswer(429, "application/json", `{"error":{"message":"Too many requests","type":"too_many_requests","code":"rate_limit_exceeded"}}`)
			resp.Header.Set("x-amzn-kiro-ratelimit-retry-after", "3000")
			return resp
		},
	}
	upstream.install(t)

	err := CallKiroAPIContext(context.Background(), account, testKiroPayload(), &KiroStreamCallback{})
	var q *upstreamQuotaError
	if !errors.As(err, &q) || !q.throttled || q.retryFor != 3*time.Second || len(upstream.responses) != 1 {
		t.Fatalf("err = %v %+v calls = %d", err, q, len(upstream.responses))
	}
	if upstreamFailureStatus(err) != http.StatusTooManyRequests {
		t.Fatalf("client status = %d", upstreamFailureStatus(err))
	}
}

func TestEndpointConfigChatAPI(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}
	post := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.apiUpdateEndpointConfig(rec, httptest.NewRequest(http.MethodPost, "/admin/api/endpoint", strings.NewReader(body)))
		return rec
	}
	get := func() map[string]interface{} {
		rec := httptest.NewRecorder()
		h.apiGetEndpointConfig(rec, httptest.NewRequest(http.MethodGet, "/admin/api/endpoint", nil))
		var out map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	if got := get()["chatApi"]; got != "auto" {
		t.Fatalf("default chatApi = %v", got)
	}
	if rec := post(`{"preferredEndpoint":"auto","chatApi":"responses"}`); rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	if got := get()["chatApi"]; got != "responses" || config.GetChatAPI() != config.ChatAPIResponses {
		t.Fatalf("chatApi = %v", got)
	}
	//! A save without the field (an older admin page) keeps the mode.
	if rec := post(`{"preferredEndpoint":"kiro","endpointFallback":false}`); rec.Code != http.StatusOK || config.GetChatAPI() != config.ChatAPIResponses {
		t.Fatalf("save without chatApi: %d, mode %q", rec.Code, config.GetChatAPI())
	}
	if rec := post(`{"preferredEndpoint":"auto","chatApi":"fast"}`); rec.Code != http.StatusBadRequest || config.GetPreferredEndpoint() != "kiro" {
		t.Fatalf("bad chatApi: %d %s, endpoint %q", rec.Code, rec.Body, config.GetPreferredEndpoint())
	}
}
