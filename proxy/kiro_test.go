package proxy

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/url"
	"sort"
	"testing"
	"time"
)

func TestParseEventStreamKeepsRepeatedAssistantContent(t *testing.T) {
	for _, tc := range []struct {
		name   string
		chunks []string
		want   string
	}{
		{"repeated equal chunks", []string{"666", "666", "666", "6"}, "6666666666"},
		{"repeated period", []string{"abab", "abab"}, "abababab"},
		{"repeated digit", []string{"18", "3", "3"}, "1833"},
		{"prefix shaped chunks", []string{"6", "66"}, "666"},
		{"overlap shaped chunks", []string{"hello world", "world!!!"}, "hello worldworld!!!"},
		{"non repeating control", []string{"123", "4567890"}, "1234567890"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stream bytes.Buffer
			for _, chunk := range tc.chunks {
				stream.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": chunk}))
			}
			stream.Write(meteringFrame(t))

			var got string
			err := parseEventStream(&stream, &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if !isThinking {
						got += text
					}
				},
			})
			if err != nil {
				t.Fatalf("unexpected parse error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("assistant text = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseEventStreamKeepsRepeatedReasoningContent(t *testing.T) {
	var stream bytes.Buffer
	for _, chunk := range []string{"666", "666", "666", "6"} {
		stream.Write(awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": chunk}))
	}
	stream.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "done"}))
	stream.Write(meteringFrame(t))

	var got string
	err := parseEventStream(&stream, &KiroStreamCallback{
		OnText: func(text string, isThinking bool) {
			if isThinking {
				got += text
			}
		},
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got != "6666666666" {
		t.Fatalf("reasoning text = %q, want %q", got, "6666666666")
	}
}

func TestParseEventStreamFinishesPendingToolUseOnEOF(t *testing.T) {
	stream := bytes.NewReader(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
		"toolUseId": "toolu_1",
		"name":      "mcpIdaProMcpStatus",
		"input":     `{"server":"ida-pro-mcp"}`,
	}))

	var toolUses []KiroToolUse
	var completed bool
	err := parseEventStream(stream, &KiroStreamCallback{
		OnToolUse: func(toolUse KiroToolUse) {
			toolUses = append(toolUses, toolUse)
		},
		OnComplete: func(_, _ int) {
			completed = true
		},
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if !completed {
		t.Fatalf("expected stream completion callback")
	}
	if len(toolUses) != 1 {
		t.Fatalf("expected pending tool use to be emitted on EOF, got %d", len(toolUses))
	}
	if toolUses[0].ToolUseID != "toolu_1" || toolUses[0].Name != "mcpIdaProMcpStatus" {
		t.Fatalf("unexpected tool use: %#v", toolUses[0])
	}
	if got := toolUses[0].Input["server"]; got != "ida-pro-mcp" {
		t.Fatalf("expected parsed tool input, got %#v", toolUses[0].Input)
	}
}

func TestParseEventStreamNilCallbackIsNoOp(t *testing.T) {
	stream := bytes.NewReader(bytes.Join([][]byte{
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hello"}),
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "thinking"}),
		awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": 12.5}),
		awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 1.25}),
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
			"name":  "mcpIdaProMcpStatus",
			"input": `{"server":"ida-pro-mcp"}`,
			"stop":  true,
		}),
	}, nil))

	if err := parseEventStream(stream, nil); err != nil {
		t.Fatalf("expected nil callback to be a no-op, got %v", err)
	}
}

func TestParseEventStreamNilCallbackFieldsAreNoOp(t *testing.T) {
	stream := bytes.NewReader(bytes.Join([][]byte{
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hello"}),
		meteringFrame(t),
	}, nil))

	if err := parseEventStream(stream, &KiroStreamCallback{}); err != nil {
		t.Fatalf("expected empty callback to be a no-op, got %v", err)
	}
}

func TestHandleToolUseEventGeneratesMissingToolUseID(t *testing.T) {
	var toolUses []KiroToolUse
	pending := &pendingToolUses{}
	err := handleToolUseEvent(map[string]interface{}{
		"name":  "mcpIdaProMcpStatus",
		"input": `{"server":"ida-pro-mcp"}`,
		"stop":  true,
	}, pending, &KiroStreamCallback{
		OnToolUse: func(toolUse KiroToolUse) {
			toolUses = append(toolUses, toolUse)
		},
	})
	if err != nil {
		t.Fatalf("unexpected tool error: %v", err)
	}
	if len(pending.order) != 0 {
		t.Fatalf("expected stopped tool use to leave no pending state, got %v", pending.order)
	}
	if len(toolUses) != 1 {
		t.Fatalf("expected one tool use, got %d", len(toolUses))
	}
	if toolUses[0].ToolUseID == "" {
		t.Fatalf("expected generated tool use id")
	}
	if toolUses[0].Name != "mcpIdaProMcpStatus" {
		t.Fatalf("unexpected tool name: %q", toolUses[0].Name)
	}
}

func TestHandleToolUseEventReplacesGeneratedIDWhenRealIDArrives(t *testing.T) {
	var toolUses []KiroToolUse
	pending := &pendingToolUses{}
	callback := &KiroStreamCallback{
		OnToolUse: func(toolUse KiroToolUse) {
			toolUses = append(toolUses, toolUse)
		},
	}

	for _, event := range []map[string]interface{}{
		{"name": "mcpIdaProMcpStatus", "input": `{"server":`},
		{"toolUseId": "toolu_real", "name": "mcpIdaProMcpStatus", "input": `"ida-pro-mcp"}`, "stop": true},
	} {
		if err := handleToolUseEvent(event, pending, callback); err != nil {
			t.Fatalf("unexpected tool error: %v", err)
		}
	}

	if len(pending.order) != 0 {
		t.Fatalf("expected stopped tool use to leave no pending state, got %v", pending.order)
	}
	if len(toolUses) != 1 {
		t.Fatalf("expected one completed tool use, got %d", len(toolUses))
	}
	if toolUses[0].ToolUseID != "toolu_real" {
		t.Fatalf("expected real tool id to replace generated id, got %q", toolUses[0].ToolUseID)
	}
	if got := toolUses[0].Input["server"]; got != "ida-pro-mcp" {
		t.Fatalf("expected joined tool input, got %#v", toolUses[0].Input)
	}
}

func TestBuildKiroTransportUsesExplicitProxyURL(t *testing.T) {
	transport := buildKiroTransport("http://proxy.local:8080")
	req := &http.Request{URL: mustParseURL(t, "https://q.us-east-1.amazonaws.com")}

	got, err := transport.Proxy(req)
	if err != nil {
		t.Fatalf("unexpected proxy error: %v", err)
	}
	assertProxyURL(t, got, "http://proxy.local:8080")
}

func TestBuildKiroTransportFallsBackToEnvironmentProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://env-proxy.local:2323")
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")

	transport := buildKiroTransport("")
	req := &http.Request{URL: mustParseURL(t, "https://q.us-east-1.amazonaws.com")}

	got, err := transport.Proxy(req)
	if err != nil {
		t.Fatalf("unexpected proxy error: %v", err)
	}
	assertProxyURL(t, got, "http://env-proxy.local:2323")
}

func TestInitKiroHttpClientKeepsShortRestTimeout(t *testing.T) {
	InitKiroHttpClient("")
	t.Cleanup(func() { InitKiroHttpClient("") })

	streamClient := kiroHttpStore.Load()
	restClient := kiroRestHttpStore.Load()

	if streamClient.Timeout != 5*time.Minute {
		t.Fatalf("expected streaming timeout to be 5m, got %s", streamClient.Timeout)
	}
	if restClient.Timeout != 30*time.Second {
		t.Fatalf("expected REST timeout to stay 30s, got %s", restClient.Timeout)
	}
}

func TestSetPayloadProfileArnForAccountUsesAccountArn(t *testing.T) {
	payload := &KiroPayload{ProfileArn: "arn:aws:codewhisperer:profile/stale"}

	setPayloadProfileArnForAccount(payload, &config.Account{ProfileArn: " arn:aws:codewhisperer:profile/current "})
	if payload.ProfileArn != "arn:aws:codewhisperer:profile/current" {
		t.Fatalf("expected current account profile ARN, got %q", payload.ProfileArn)
	}
}

func TestSetPayloadProfileArnForAccountPreservesExplicitPayloadArn(t *testing.T) {
	payload := &KiroPayload{ProfileArn: " arn:aws:codewhisperer:profile/explicit "}

	setPayloadProfileArnForAccount(payload, &config.Account{})
	if payload.ProfileArn != "arn:aws:codewhisperer:profile/explicit" {
		t.Fatalf("expected explicit payload profile ARN to be preserved, got %q", payload.ProfileArn)
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("invalid test URL: %v", err)
	}
	return parsed
}

func assertProxyURL(t *testing.T, got *url.URL, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("expected proxy URL %q, got nil", want)
	}
	if got.String() != want {
		t.Fatalf("expected proxy URL %q, got %q", want, got.String())
	}
}

func awsEventStreamFrame(t *testing.T, eventType string, payload map[string]interface{}) []byte {
	t.Helper()
	return awsEventStreamFrameWithHeaders(t, map[string]string{
		":event-type":   eventType,
		":message-type": "event",
	}, payload)
}

func meteringFrame(t *testing.T) []byte {
	//! meteringFrame is the trailer upstream sends after a finished answer.
	t.Helper()
	return awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.01})
}

func awsEventStreamFrameWithHeaders(t *testing.T, headerValues map[string]string, payload map[string]interface{}) []byte {
	t.Helper()

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	names := make([]string, 0, len(headerValues))
	for name := range headerValues {
		names = append(names, name)
	}
	sort.Strings(names)
	var headers []byte
	for _, name := range names {
		value := []byte(headerValues[name])
		headers = append(headers, byte(len(name)))
		headers = append(headers, name...)
		headers = append(headers, 7)
		headers = append(headers, byte(len(value)>>8), byte(len(value)))
		headers = append(headers, value...)
	}

	totalLength := 12 + len(headers) + len(payloadBytes) + 4
	frame := make([]byte, 12, totalLength)
	binary.BigEndian.PutUint32(frame[0:4], uint32(totalLength))
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(headers)))
	binary.BigEndian.PutUint32(frame[8:12], crc32.ChecksumIEEE(frame[:8]))
	frame = append(frame, headers...)
	frame = append(frame, payloadBytes...)
	return binary.BigEndian.AppendUint32(frame, crc32.ChecksumIEEE(frame))
}

func TestSetPayloadProfileArnForAccountClearsAPIKeyProfile(t *testing.T) {
	payload := &KiroPayload{ProfileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/STALE"}
	setPayloadProfileArnForAccount(payload, &config.Account{
		AuthMethod: config.AuthMethodAPIKey,
		KiroApiKey: "ksk_test",
		ProfileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/STALE",
	})
	if payload.ProfileArn != "" {
		t.Fatalf("expected empty profileArn for API key account, got %q", payload.ProfileArn)
	}
}

func TestEndpointsForAccountUsesCLIForAPIKey(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	account := &config.Account{AuthMethod: config.AuthMethodAPIKey, KiroApiKey: "ksk_x", Region: "eu-central-1"}
	eps := endpointsForAccount(account)
	if len(eps) != 1 || eps[0].Name != "Kiro CLI" || eps[0].Origin != "KIRO_CLI" {
		t.Fatalf("expected single CLI endpoint, got %+v", eps)
	}
	if got := kiroEndpointURL(eps[0], account, ""); got != "https://runtime.eu-central-1.kiro.dev/" {
		t.Fatalf("cli url = %q", got)
	}

	//! A stale ARN (from before a re-import) must not move the key to another region's runtime.
	account.ProfileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/STALE"
	if got := kiroEndpointURL(eps[0], account, account.ProfileArn); got != "https://runtime.eu-central-1.kiro.dev/" {
		t.Fatalf("API key region must ignore profile ARNs, got %q", got)
	}

	if eps := endpointsForAccount(&config.Account{AccessToken: "oauth", AuthMethod: "social"}); len(eps) == 0 || eps[0].Origin == "KIRO_CLI" {
		t.Fatalf("OAuth accounts must keep the IDE endpoints, got %+v", eps)
	}
}

func TestCallKiroAPIUsesCLIRuntimeForAPIKeyAccount(t *testing.T) {
	var captured *http.Request
	var body []byte
	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		captured = req
		body, _ = io.ReadAll(req.Body)
		frames := append(
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hi"}),
			meteringFrame(t)...,
		)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(frames)), Header: make(http.Header)}, nil
	})})
	t.Cleanup(func() { kiroHttpStore.Store(oldClient) })

	account := &config.Account{ID: "api-1", KiroApiKey: "ksk_live_test", AuthMethod: config.AuthMethodAPIKey, Region: "eu-central-1"}
	payload := testKiroPayload()
	payload.ProfileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/EXPLICIT"

	var text string
	err := CallKiroAPIContext(context.Background(), account, payload, &KiroStreamCallback{
		OnText: func(s string, _ bool) { text += s },
	})
	if err != nil {
		t.Fatalf("CallKiroAPIContext: %v", err)
	}
	if text != "hi" {
		t.Fatalf("text = %q", text)
	}
	if captured == nil {
		t.Fatal("expected one upstream request")
	}
	if got := captured.URL.String(); got != "https://runtime.eu-central-1.kiro.dev/" {
		t.Fatalf("url = %q", got)
	}
	for header, want := range map[string]string{
		"Authorization":               "Bearer ksk_live_test",
		"tokentype":                   "API_KEY",
		"Content-Type":                "application/x-amz-json-1.0",
		"X-Amz-Target":                "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		"x-amzn-codewhisperer-optout": "false",
		"x-amzn-kiro-agent-mode":      "",
	} {
		if got := captured.Header.Get(header); got != want {
			t.Fatalf("header %s = %q, want %q", header, got, want)
		}
	}

	var sent map[string]interface{}
	if err := json.Unmarshal(body, &sent); err != nil {
		t.Fatalf("decode sent payload: %v", err)
	}
	if _, ok := sent["profileArn"]; ok {
		t.Fatalf("API key request must not carry a profileArn, got %v", sent["profileArn"])
	}
	origin := sent["conversationState"].(map[string]interface{})["currentMessage"].(map[string]interface{})["userInputMessage"].(map[string]interface{})["origin"]
	if origin != "KIRO_CLI" {
		t.Fatalf("origin = %v, want KIRO_CLI", origin)
	}
	if payload.ProfileArn != "arn:aws:codewhisperer:us-east-1:123456789012:profile/EXPLICIT" {
		t.Fatalf("caller payload must be restored after the call, got %q", payload.ProfileArn)
	}
}
