package proxy

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func markupTestTools() map[string]map[string]string {
	return map[string]map[string]string{
		"Read":  {"path": "string", "limit": "integer"},
		"Bash":  {"command": "string"},
		"Multi": {"ids": "array", "opts": "object", "force": "boolean", "label": "string"},
		"Loose": {},
	}
}

// runMarkupFilter feeds chunks like the stream loop does, then flushes at stream end.
func runMarkupFilter(t *testing.T, chunks []string) (string, []KiroToolUse) {
	t.Helper()
	f := newToolMarkupFilter(markupTestTools())
	var text strings.Builder
	for _, chunk := range chunks {
		text.WriteString(f.Push(chunk))
	}
	text.WriteString(f.Flush())
	var tools []KiroToolUse
	f.emitRescued(&KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { tools = append(tools, tu) }})
	return text.String(), tools
}

func byteChunks(s string) []string {
	chunks := make([]string, 0, len(s))
	for i := 0; i < len(s); i++ {
		chunks = append(chunks, s[i:i+1])
	}
	return chunks
}

func TestToolMarkupFilterPassesPlainTextWithoutDelay(t *testing.T) {
	f := newToolMarkupFilter(markupTestTools())
	for _, chunk := range []string{"Hello, ", "a < b and x<y ", "count", " done."} {
		if got := f.Push(chunk); got != chunk {
			t.Fatalf("Push(%q) = %q, plain text must pass through at once", chunk, got)
		}
	}
	if rest := f.Flush(); rest != "" {
		t.Fatalf("nothing should be held, flushed %q", rest)
	}
}

func TestToolMarkupFilterHoldsOnlyPendingTagPrefix(t *testing.T) {
	f := newToolMarkupFilter(markupTestTools())
	if got := f.Push("Hello <"); got != "Hello " {
		t.Fatalf("Push = %q, want text before the possible tag", got)
	}
	if got := f.Push("b>bold</b>"); got != "<b>bold</b>" {
		t.Fatalf("Push = %q, want the released non-markup tag", got)
	}
	if got := f.Push("see <invo"); got != "see " {
		t.Fatalf("Push = %q, want the invoke prefix held", got)
	}
	if got := f.Flush(); got != "<invo" {
		t.Fatalf("Flush = %q, want the held prefix released", got)
	}
}

func TestToolMarkupFilterRescuesWrappedInvoke(t *testing.T) {
	in := "Let me read it.\n\n<function_calls>\n<invoke name=\"Read\">\n<parameter name=\"path\">/tmp/a.txt</parameter>\n<parameter name=\"limit\">20</parameter>\n</invoke>\n</function_calls>\n"
	text, tools := runMarkupFilter(t, []string{in})
	if text != "Let me read it.\n\n" {
		t.Fatalf("text = %q", text)
	}
	if len(tools) != 1 || tools[0].Name != "Read" {
		t.Fatalf("tools = %#v", tools)
	}
	want := map[string]interface{}{"path": "/tmp/a.txt", "limit": float64(20)}
	if !reflect.DeepEqual(tools[0].Input, want) {
		t.Fatalf("input = %#v, want %#v", tools[0].Input, want)
	}
	if !strings.HasPrefix(tools[0].ToolUseID, "toolu_") {
		t.Fatalf("rescued tool needs a tool id, got %q", tools[0].ToolUseID)
	}
}

func TestToolMarkupFilterRescuesAcrossEveryChunkBoundary(t *testing.T) {
	in := "Run it: <function_calls><invoke name=\"Bash\"><parameter name=\"command\">ls -la | grep \"x\" < in</parameter></invoke></function_calls>"
	text, tools := runMarkupFilter(t, byteChunks(in))
	if text != "Run it: " {
		t.Fatalf("text = %q, want markup removed", text)
	}
	if len(tools) != 1 || tools[0].Input["command"] != `ls -la | grep "x" < in` {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestToolMarkupFilterRescuesMultipleInvokesInOrder(t *testing.T) {
	in := "<function_calls>\n<invoke name=\"Read\"><parameter name=\"path\">/a</parameter></invoke>\n<invoke name=\"Bash\"><parameter name=\"command\">pwd</parameter></invoke>\n</function_calls>"
	text, tools := runMarkupFilter(t, byteChunks(in))
	if strings.TrimSpace(text) != "" {
		t.Fatalf("text = %q, want no visible markup", text)
	}
	if len(tools) != 2 || tools[0].Name != "Read" || tools[1].Name != "Bash" {
		t.Fatalf("tools = %#v", tools)
	}
	if tools[0].ToolUseID == tools[1].ToolUseID {
		t.Fatalf("rescued tools need distinct ids")
	}
}

func TestToolMarkupFilterRescuesNamespacedMarkup(t *testing.T) {
	ns := "antml" + ":"
	in := "<" + ns + "function_calls><" + ns + "invoke name=\"Read\"><" + ns + "parameter name=\"path\">/a</" + ns + "parameter></" + ns + "invoke></" + ns + "function_calls>"
	text, tools := runMarkupFilter(t, byteChunks(in))
	if text != "" {
		t.Fatalf("text = %q, want markup removed", text)
	}
	if len(tools) != 1 || tools[0].Input["path"] != "/a" {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestToolMarkupFilterCoercesParametersBySchema(t *testing.T) {
	in := `<invoke name="Multi">` +
		`<parameter name="ids">[1, 2]</parameter>` +
		`<parameter name="opts">{"deep": true}</parameter>` +
		`<parameter name="force">true</parameter>` +
		`<parameter name="label">42</parameter>` +
		`</invoke>` +
		`<invoke name="Loose"><parameter name="n">7</parameter><parameter name="s"> keep  spaces </parameter></invoke>`
	_, tools := runMarkupFilter(t, []string{in})
	if len(tools) != 2 {
		t.Fatalf("tools = %#v", tools)
	}
	want := map[string]interface{}{
		"ids":   []interface{}{float64(1), float64(2)},
		"opts":  map[string]interface{}{"deep": true},
		"force": true,
		"label": "42",
	}
	if !reflect.DeepEqual(tools[0].Input, want) {
		t.Fatalf("typed input = %#v, want %#v", tools[0].Input, want)
	}
	loose := map[string]interface{}{"n": float64(7), "s": " keep  spaces "}
	if !reflect.DeepEqual(tools[1].Input, loose) {
		t.Fatalf("untyped input = %#v, want %#v", tools[1].Input, loose)
	}
}

func TestToolMarkupFilterLeavesUndeclaredToolsAsText(t *testing.T) {
	in := `Example: <function_calls><invoke name="Write"><parameter name="path">/a</parameter></invoke></function_calls>`
	text, tools := runMarkupFilter(t, byteChunks(in))
	if text != in {
		t.Fatalf("text = %q, want undeclared markup untouched", text)
	}
	if len(tools) != 0 {
		t.Fatalf("undeclared tool must not be rescued, got %#v", tools)
	}
}

func TestToolMarkupFilterReleasesUnclosedInvokeAtEnd(t *testing.T) {
	in := `start <function_calls><invoke name="Read"><parameter name="path">/a`
	text, tools := runMarkupFilter(t, byteChunks(in))
	if text != in {
		t.Fatalf("text = %q, want the unfinished markup released as text", text)
	}
	if len(tools) != 0 {
		t.Fatalf("an unclosed invoke must not run, got %#v", tools)
	}
}

func TestToolMarkupFilterKeepsPlainCountPrefix(t *testing.T) {
	//! Upstream PR #114 strips a trailing "count" as a garbled wrapper; ordinary words must survive.
	in := `word count<invoke name="Read"><parameter name="path">/a</parameter></invoke>`
	text, tools := runMarkupFilter(t, byteChunks(in))
	if text != "word count" {
		t.Fatalf("text = %q, want the word kept", text)
	}
	if len(tools) != 1 {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestToolMarkupFilterIgnoresMarkupInsideThinking(t *testing.T) {
	in := `<thinking>maybe <invoke name="Read"><parameter name="path">/a</parameter></invoke></thinking>answer`
	text, tools := runMarkupFilter(t, byteChunks(in))
	if text != in {
		t.Fatalf("text = %q, want thinking left untouched", text)
	}
	if len(tools) != 0 {
		t.Fatalf("markup inside thinking must not run, got %#v", tools)
	}
}

func TestToolMarkupFilterDropsDuplicateOfRealToolCall(t *testing.T) {
	f := newToolMarkupFilter(markupTestTools())
	f.markSeen(KiroToolUse{ToolUseID: "real", Name: "Read", Input: map[string]interface{}{"path": "/a"}})
	f.Push(`<invoke name="Read"><parameter name="path">/a</parameter></invoke>`)
	f.Push(`<invoke name="Read"><parameter name="path">/b</parameter></invoke>`)
	f.Flush()
	var tools []KiroToolUse
	f.emitRescued(&KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { tools = append(tools, tu) }})
	if len(tools) != 1 || tools[0].Input["path"] != "/b" {
		t.Fatalf("tools = %#v, want only the call not already made", tools)
	}
}

func TestParseEventStreamRescuesLeakedToolMarkup(t *testing.T) {
	var text string
	var tools []KiroToolUse
	var stopReason string
	callback := &KiroStreamCallback{
		OnText:       func(s string, _ bool) { text += s },
		OnToolUse:    func(tu KiroToolUse) { tools = append(tools, tu) },
		OnStopReason: func(reason string) { stopReason = reason },
		markupTools:  markupTestTools(),
	}
	//! No stop reason and no metering: only the rescued call proves the turn complete.
	err := parseFrames(t, callback,
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Checking.<function_calls><invoke name=\"Re"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "ad\"><parameter name=\"path\">/a</parameter></invoke></function_calls>"}),
	)
	if err != nil {
		t.Fatalf("a rescued tool call completes the turn, got %v", err)
	}
	if text != "Checking." {
		t.Fatalf("text = %q", text)
	}
	if len(tools) != 1 || tools[0].Name != "Read" || tools[0].Input["path"] != "/a" {
		t.Fatalf("tools = %#v", tools)
	}
	if stopReason != "" {
		t.Fatalf("stop reason = %q", stopReason)
	}
}

func TestParseEventStreamSkipsMarkupDuplicatingRealToolUse(t *testing.T) {
	var tools []KiroToolUse
	callback := &KiroStreamCallback{
		OnToolUse:   func(tu KiroToolUse) { tools = append(tools, tu) },
		markupTools: markupTestTools(),
	}
	err := parseFrames(t, callback,
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": `<invoke name="Read"><parameter name="path">/a</parameter></invoke>`}),
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "tooluse_real", "name": "Read", "input": `{"path":"/a"}`, "stop": true}),
		meteringFrame(t),
	)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(tools) != 1 || tools[0].ToolUseID != "tooluse_real" {
		t.Fatalf("tools = %#v, want only the real call", tools)
	}
}

func TestParseEventStreamWithoutDeclaredToolsPassesMarkupThrough(t *testing.T) {
	in := `<invoke name="Read"><parameter name="path">/a</parameter></invoke>`
	var text string
	var tools int
	err := parseFrames(t, &KiroStreamCallback{
		OnText:    func(s string, _ bool) { text += s },
		OnToolUse: func(KiroToolUse) { tools++ },
	},
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": in}),
		meteringFrame(t),
	)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if text != in || tools != 0 {
		t.Fatalf("text=%q tools=%d, want markup untouched", text, tools)
	}
}

func markupTestPayload() *KiroPayload {
	payload := testKiroPayload()
	tool := KiroToolWrapper{}
	tool.ToolSpecification.Name = "read_file"
	tool.ToolSpecification.InputSchema = InputSchema{JSON: map[string]interface{}{
		"type":       "object",
		"properties": map[string]interface{}{"limit": map[string]interface{}{"type": "integer"}},
	}}
	payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext = &UserInputMessageContext{Tools: []KiroToolWrapper{tool}}
	payload.ToolNameMap = map[string]string{"read_file": "mcp__fs__read_file"}
	return payload
}

func TestCallKiroAPIRescuesMarkupForDeclaredTools(t *testing.T) {
	newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": `<invoke name="read_file"><parameter name="limit">5</parameter></invoke>`}),
			meteringFrame(t),
		)
	})

	var tools []KiroToolUse
	err := CallKiroAPIContext(context.Background(), testAccount(t), markupTestPayload(), &KiroStreamCallback{
		OnToolUse: func(tu KiroToolUse) { tools = append(tools, tu) },
	})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "mcp__fs__read_file" || tools[0].Input["limit"] != float64(5) {
		t.Fatalf("tools = %#v, want the rescued call under the client's tool name", tools)
	}
}

func TestToolMarkupRescueCanBeDisabled(t *testing.T) {
	t.Setenv(toolMarkupRescueEnv, "off")
	in := `<invoke name="read_file"><parameter name="limit">5</parameter></invoke>`
	newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": in}),
			meteringFrame(t),
		)
	})

	var text string
	var tools int
	err := CallKiroAPIContext(context.Background(), testAccount(t), markupTestPayload(), &KiroStreamCallback{
		OnText:    func(s string, _ bool) { text += s },
		OnToolUse: func(KiroToolUse) { tools++ },
	})
	if err != nil && !errors.Is(err, errUpstreamTruncatedResponse) {
		t.Fatalf("call: %v", err)
	}
	if text != in || tools != 0 {
		t.Fatalf("text=%q tools=%d, want pass-through when disabled", text, tools)
	}
}

func TestToolMarkupFilterKeepsQuotedExamplesAsText(t *testing.T) {
	invoke := `<invoke name="Bash"><parameter name="command">rm -rf ~/proj</parameter></invoke>`
	cases := map[string]string{
		"fenced example":         "Here is the format:\n```xml\n" + invoke + "\n```\nThat's it.",
		"unclosed fence at end":  "Here is the format:\n```xml\n" + invoke,
		"inline code at end":     "Use `" + invoke + "`",
		"prose after the markup": "For example " + invoke + " would delete it, so I won't run it.",
		"wrapped then prose":     "<function_calls>" + invoke + "</function_calls>\nThat is how a call looks.",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			for _, chunks := range [][]string{{in}, byteChunks(in)} {
				text, tools := runMarkupFilter(t, chunks)
				if text != in {
					t.Fatalf("text = %q, want the example untouched", text)
				}
				if len(tools) != 0 {
					t.Fatalf("a quoted example must never run, got %#v", tools)
				}
			}
		})
	}
}

func TestToolMarkupFilterRescuesRunFollowedOnlyByWhitespace(t *testing.T) {
	in := "Checking.\n```\ncode\n```\n<function_calls>\n<invoke name=\"Read\"><parameter name=\"path\">/a</parameter></invoke>\n</function_calls>\n\n  "
	for _, chunks := range [][]string{{in}, byteChunks(in)} {
		text, tools := runMarkupFilter(t, chunks)
		if text != "Checking.\n```\ncode\n```\n" {
			t.Fatalf("text = %q", text)
		}
		if len(tools) != 1 || tools[0].Input["path"] != "/a" {
			t.Fatalf("a call that ends the turn after a closed fence must be rescued, got %#v", tools)
		}
	}
}

func TestToolMarkupFilterRescuesSecondWrapperBlock(t *testing.T) {
	first := "<function_calls>\n<invoke name=\"Read\"><parameter name=\"path\">/a</parameter></invoke>\n</function_calls>\n"
	second := "<function_calls>\n<invoke name=\"Bash\"><parameter name=\"command\">pwd</parameter></invoke>\n</function_calls>"
	for name, chunks := range map[string][]string{
		"whole":      {first, second},
		"every byte": byteChunks(first + second),
		"bare open":  {first, "<function_calls>", "\n", second[len("<function_calls>\n"):]},
	} {
		text, tools := runMarkupFilter(t, chunks)
		if strings.TrimSpace(text) != "" {
			t.Fatalf("%s: text = %q, want no visible markup", name, text)
		}
		if len(tools) != 2 || tools[0].Name != "Read" || tools[1].Name != "Bash" {
			t.Fatalf("%s: tools = %#v", name, tools)
		}
	}
}

func TestToolMarkupFilterReleasesWrapperWithoutInvokeAfterRun(t *testing.T) {
	in := "<function_calls>\n<invoke name=\"Read\"><parameter name=\"path\">/a</parameter></invoke>\n</function_calls>\n<function_calls>"
	text, tools := runMarkupFilter(t, []string{in})
	if len(tools) != 0 || !strings.Contains(text, "<invoke name=\"Read\">") {
		t.Fatalf("a run followed by a dangling wrapper is not the end of the turn: text=%q tools=%#v", text, tools)
	}
}

func TestToolMarkupFilterKeepsIdenticalParallelInvokes(t *testing.T) {
	inv := `<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
	in := "<function_calls>\n" + inv + "\n" + inv + "\n</function_calls>"
	for _, chunks := range [][]string{{in}, byteChunks(in)} {
		_, tools := runMarkupFilter(t, chunks)
		if len(tools) != 2 {
			t.Fatalf("two identical calls in one block are two calls, got %#v", tools)
		}
	}
}

func TestToolMarkupFilterDropsOnlyAsManyDuplicatesAsRealCalls(t *testing.T) {
	inv := `<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
	f := newToolMarkupFilter(markupTestTools())
	f.markSeen(KiroToolUse{ToolUseID: "real", Name: "Bash", Input: map[string]interface{}{"command": "ls"}})
	f.Push("<function_calls>" + inv + inv + "</function_calls>")
	f.Flush()
	var tools []KiroToolUse
	callback := &KiroStreamCallback{}
	//! Mirrors the stream loop, where rescued calls go through the tracking callback that also calls markSeen.
	callback.OnToolUse = func(tu KiroToolUse) {
		tools = append(tools, tu)
		f.markSeen(tu)
	}
	f.emitRescued(callback)
	if len(tools) != 1 {
		t.Fatalf("one real call covers one markup copy, the other must run; got %#v", tools)
	}
}

func TestToolMarkupFilterRescuesRunWithTruncatedClosingWrapper(t *testing.T) {
	inv := `<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
	for _, tail := range []string{"<", "</", "</function_ca", "\n</function_calls"} {
		in := "Go. <function_calls>" + inv + tail
		for _, chunks := range [][]string{{in}, byteChunks(in)} {
			text, tools := runMarkupFilter(t, chunks)
			if text != "Go. " || len(tools) != 1 {
				t.Fatalf("tail %q: text=%q tools=%#v, want the call rescued and no stray tag bytes", tail, text, tools)
			}
		}
	}
}

func TestToolMarkupFilterKeepsBareRunFollowedByAngleBracketAsText(t *testing.T) {
	in := `x <invoke name="Bash"><parameter name="command">ls</parameter></invoke><`
	text, tools := runMarkupFilter(t, byteChunks(in))
	if text != in || len(tools) != 0 {
		t.Fatalf("text=%q tools=%#v, a bare run with trailing text is not a clean turn end", text, tools)
	}
}

func TestToolMarkupFilterRescuesSecondWrapperWithTruncatedClosing(t *testing.T) {
	inv := `<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
	in := "<function_calls>" + inv + "</function_calls>\n<function_calls>" + inv + "</fun"
	for _, chunks := range [][]string{{in}, byteChunks(in)} {
		text, tools := runMarkupFilter(t, chunks)
		if strings.TrimSpace(text) != "" || len(tools) != 2 {
			t.Fatalf("text=%q tools=%#v", text, tools)
		}
	}
}

func TestToolMarkupFilterAbandonReleasesHeldMarkupAsText(t *testing.T) {
	f := newToolMarkupFilter(markupTestTools())
	inv := `<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
	got := f.Push("a <function_calls>"+inv+" ") + f.Push("<invo")
	if got != "a " {
		t.Fatalf("Push = %q", got)
	}
	if rest := f.Abandon(); rest != "<function_calls>"+inv+" <invo" {
		t.Fatalf("Abandon = %q, want everything held returned as text", rest)
	}
	if rest := f.Abandon(); rest != "" {
		t.Fatalf("second Abandon = %q", rest)
	}
	var tools []KiroToolUse
	f.emitRescued(&KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { tools = append(tools, tu) }})
	if len(tools) != 0 {
		t.Fatalf("an aborted stream must not run held calls, got %#v", tools)
	}
}

func TestParseEventStreamFlushesHeldMarkupTextOnUpstreamError(t *testing.T) {
	var text string
	callback := &KiroStreamCallback{
		OnText:      func(s string, _ bool) { text += s },
		markupTools: markupTestTools(),
	}
	err := parseFrames(t, callback,
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Looking <invo"}),
		awsEventStreamFrameWithHeaders(t, map[string]string{
			":message-type":   "exception",
			":exception-type": "InternalServerException",
		}, map[string]interface{}{"message": "boom"}),
	)
	if !errors.Is(err, errKiroEventStreamUpstream) {
		t.Fatalf("err = %v", err)
	}
	if text != "Looking <invo" {
		t.Fatalf("text = %q, held bytes must reach the client before the error", text)
	}
}

func TestParseEventStreamKeepsRetryOpenWhenOnlyHeldTextWasPending(t *testing.T) {
	callback := &KiroStreamCallback{
		OnText:      func(string, bool) {},
		markupTools: markupTestTools(),
	}
	emitted, err := parseEventStreamTracked(bytes.NewReader(bytes.Join([][]byte{
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "<invo"}),
		awsEventStreamFrameWithHeaders(t, map[string]string{
			":message-type":   "exception",
			":exception-type": "InternalServerException",
		}, map[string]interface{}{"message": "boom"}),
	}, nil)), callback)
	if err == nil || emitted {
		t.Fatalf("emitted=%t err=%v, nothing reached the client so the attempt stays retryable", emitted, err)
	}
}
