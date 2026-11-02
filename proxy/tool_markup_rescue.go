package proxy

import (
	"encoding/json"
	"kiro-proxy/logger"
	"os"
	"strings"

	"github.com/google/uuid"
)

//! Kiro sometimes streams Claude's own tool-call markup (<function_calls><invoke ...>)
//! as answer text instead of a toolUseEvent, split across frames. Clients then show raw
//! XML and never run the tool. The filter holds text back only while a tag prefix is
//! pending, turns complete <invoke> blocks for declared tools into tool calls, and
//! passes everything else through unchanged.
//!
//! A real call always ends the turn, while a model quoting the format as an example keeps
//! writing (a closing fence, an explanation). So markup inside a code span or fence stays
//! text, and a run of invokes is only rescued when nothing but whitespace follows it.

const toolMarkupRescueEnv = "KIRO_TOOL_MARKUP_RESCUE"

// maxMarkupNameLen bounds a tool or parameter name, so prose that merely starts
// like a tag is released instead of held until stream end.
const maxMarkupNameLen = 200

type toolMarkupTags struct {
	callsOpen, callsClose   string
	invokeOpen, invokeClose string
	paramOpen, paramClose   string
}

func newToolMarkupTags(ns string) toolMarkupTags {
	return toolMarkupTags{
		callsOpen:   "<" + ns + "function_calls>",
		callsClose:  "</" + ns + "function_calls>",
		invokeOpen:  "<" + ns + `invoke name="`,
		invokeClose: "</" + ns + "invoke>",
		paramOpen:   "<" + ns + `parameter name="`,
		paramClose:  "</" + ns + "parameter>",
	}
}

// toolMarkupDialects covers leaks with and without the namespace prefix Claude's native format puts on every tag.
var toolMarkupDialects = []toolMarkupTags{
	newToolMarkupTags(""),
	newToolMarkupTags("antml" + ":"),
}

type markupParse int

const (
	markupInvalid markupParse = iota
	markupNeedMore
	markupComplete
)

func toolMarkupRescueEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(toolMarkupRescueEnv))) {
	case "off", "0", "false", "no", "disabled":
		return false
	}
	return true
}

// withToolMarkupRescue arms the filter with the tools the request declared upstream.
func withToolMarkupRescue(callback *KiroStreamCallback, payload *KiroPayload) *KiroStreamCallback {
	if callback == nil || callback.OnToolUse == nil || payload == nil || !toolMarkupRescueEnabled() {
		return callback
	}
	tools := declaredToolParamTypes(payload)
	if len(tools) == 0 {
		return callback
	}
	armed := *callback
	armed.markupTools = tools
	return &armed
}

// declaredToolParamTypes maps each declared upstream tool name to its parameters' JSON schema types.
func declaredToolParamTypes(payload *KiroPayload) map[string]map[string]string {
	ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
	if ctx == nil || len(ctx.Tools) == 0 {
		return nil
	}
	tools := make(map[string]map[string]string, len(ctx.Tools))
	for _, tool := range ctx.Tools {
		if name := tool.ToolSpecification.Name; name != "" {
			tools[name] = schemaPropertyTypes(tool.ToolSpecification.InputSchema.JSON)
		}
	}
	return tools
}

func schemaPropertyTypes(schema interface{}) map[string]string {
	types := make(map[string]string)
	obj, _ := schema.(map[string]interface{})
	props, _ := obj["properties"].(map[string]interface{})
	for key, prop := range props {
		propObj, _ := prop.(map[string]interface{})
		switch t := propObj["type"].(type) {
		case string:
			types[key] = t
		case []interface{}:
			//! A nullable field (["string","null"]) still has exactly one concrete type.
			var concrete []string
			for _, v := range t {
				if s, ok := v.(string); ok && s != "null" {
					concrete = append(concrete, s)
				}
			}
			if len(concrete) == 1 {
				types[key] = concrete[0]
			}
		}
	}
	return types
}

type toolMarkupFilter struct {
	tools      map[string]map[string]string
	buf        string
	inThinking bool
	// calls is the dialect of a run of rescued invokes whose closing wrapper may still follow.
	calls *toolMarkupTags
	// run holds the parsed invokes of the current run and runRaw their markup. The run is
	// committed when the stream ends with only whitespace after it, and released as text otherwise.
	run     []KiroToolUse
	runRaw  strings.Builder
	rescued []KiroToolUse
	seen    map[string]bool
	// Code-span tracking over emitted text: pending backticks, open fence, open inline span.
	ticks      int
	fenced     bool
	inlineCode bool
}

func newToolMarkupFilter(tools map[string]map[string]string) *toolMarkupFilter {
	if len(tools) == 0 {
		return nil
	}
	return &toolMarkupFilter{tools: tools, seen: make(map[string]bool)}
}

// Push takes one upstream text chunk and returns the text that is safe to emit now.
func (f *toolMarkupFilter) Push(chunk string) string {
	if f == nil {
		return chunk
	}
	f.buf += chunk
	return f.drain(false)
}

// Flush releases held text at stream end; an unfinished invoke is returned as text.
func (f *toolMarkupFilter) Flush() string {
	if f == nil {
		return ""
	}
	return f.drain(true)
}

func (f *toolMarkupFilter) markSeen(toolUse KiroToolUse) {
	if f == nil {
		return
	}
	f.seen[toolUseSignature(toolUse)] = true
}

func (f *toolMarkupFilter) emitRescued(callback *KiroStreamCallback) {
	//! Rescued calls are emitted at stream end, after every real toolUseEvent, so a leaked
	//! copy of a call Kiro also sent structurally is dropped instead of run twice.
	if f == nil || len(f.rescued) == 0 {
		return
	}
	rescued, duplicates := 0, 0
	for _, toolUse := range f.rescued {
		signature := toolUseSignature(toolUse)
		if f.seen[signature] {
			duplicates++
			continue
		}
		f.seen[signature] = true
		toolUse.ToolUseID = "toolu_" + uuid.New().String()
		rescued++
		if callback != nil && callback.OnToolUse != nil {
			callback.OnToolUse(toolUse)
		}
	}
	f.rescued = nil
	logger.Infof("[KiroAPI] Rescued %d tool call(s) from leaked markup, %d duplicate(s) dropped", rescued, duplicates)
}

func toolUseSignature(toolUse KiroToolUse) string {
	//! json.Marshal sorts map keys, so equal inputs give equal signatures.
	data, _ := json.Marshal(toolUse.Input)
	return toolUse.Name + "\x00" + string(data)
}

func (f *toolMarkupFilter) drain(final bool) string {
	var out strings.Builder
	for f.buf != "" {
		if f.calls != nil {
			if !f.stepCalls(final) {
				break
			}
			continue
		}
		if len(f.run) > 0 {
			if !f.stepAfterRun(final, &out) {
				break
			}
			continue
		}
		idx := strings.IndexByte(f.buf, '<')
		if idx < 0 {
			f.write(&out, f.buf)
			f.buf = ""
			break
		}
		f.write(&out, f.buf[:idx])
		f.buf = f.buf[idx:]
		if !f.stepTag(final, &out) {
			break
		}
	}
	if final && len(f.run) > 0 && strings.TrimSpace(f.buf) == "" {
		f.calls = nil
		f.commitTrailingWhitespace()
	}
	return out.String()
}

// stepAfterRun decides what follows a finished run of invokes: whitespace is held,
// another invoke extends the run, and anything else turns the run back into text.
func (f *toolMarkupFilter) stepAfterRun(final bool, out *strings.Builder) bool {
	rest := trimMarkupSpace(f.buf)
	if rest == "" {
		//! Trailing whitespace stays held: the run commits only if the stream ends here.
		return final && f.commitTrailingWhitespace()
	}
	for i := range toolMarkupDialects {
		tags := &toolMarkupDialects[i]
		body := rest
		if strings.HasPrefix(rest, tags.callsOpen) {
			body = trimMarkupSpace(rest[len(tags.callsOpen):])
		} else if !strings.HasPrefix(rest, tags.invokeOpen) {
			if !final && (isPartialTag(rest, tags.callsOpen) || isPartialTag(rest, tags.invokeOpen)) {
				return false
			}
			continue
		}
		n, status := f.parseInvoke(body, tags)
		if status == markupNeedMore && !final {
			return false
		}
		if status == markupComplete {
			consumed := len(f.buf) - len(body) + n
			f.runRaw.WriteString(f.buf[:consumed])
			f.buf = f.buf[consumed:]
			f.calls = tags
			return true
		}
		break
	}
	f.releaseRun(out)
	return true
}

func (f *toolMarkupFilter) commitTrailingWhitespace() bool {
	f.rescued = append(f.rescued, f.run...)
	f.run = nil
	f.runRaw.Reset()
	f.buf = ""
	return true
}

// releaseRun gives back a run that turned out not to end the turn: its markup is shown as text.
func (f *toolMarkupFilter) releaseRun(out *strings.Builder) {
	f.write(out, f.runRaw.String())
	f.run = nil
	f.runRaw.Reset()
}

func (f *toolMarkupFilter) emitBytes(out *strings.Builder, n int) {
	f.write(out, f.buf[:n])
	f.buf = f.buf[n:]
}

// write emits text and tracks whether it leaves a Markdown code span or fence open.
func (f *toolMarkupFilter) write(out *strings.Builder, s string) {
	out.WriteString(s)
	for i := 0; i < len(s); i++ {
		if s[i] == '`' {
			f.ticks++
			continue
		}
		f.fenced, f.inlineCode = f.codeState()
		f.ticks = 0
		if s[i] == '\n' {
			f.inlineCode = false
		}
	}
}

// codeState applies pending backticks: three or more toggle a fence, fewer toggle an inline span.
func (f *toolMarkupFilter) codeState() (fenced, inline bool) {
	fenced, inline = f.fenced, f.inlineCode
	switch {
	case f.ticks >= 3:
		fenced, inline = !fenced, false
	case f.ticks > 0 && !fenced:
		inline = !inline
	}
	return fenced, inline
}

func (f *toolMarkupFilter) inCode() bool {
	fenced, inline := f.codeState()
	return fenced || inline
}

// stepTag handles a buffer that starts with '<'. It returns false while the buffer must wait for more text.
func (f *toolMarkupFilter) stepTag(final bool, out *strings.Builder) bool {
	if f.inThinking {
		//! Markup inside reasoning is the model thinking about a call, not making one.
		if strings.HasPrefix(f.buf, thinkingCloseTag) {
			f.inThinking = false
			f.emitBytes(out, len(thinkingCloseTag))
			return true
		}
		if !final && isPartialTag(f.buf, thinkingCloseTag) {
			return false
		}
		f.emitBytes(out, 1)
		return true
	}
	if strings.HasPrefix(f.buf, thinkingOpenTag) {
		f.inThinking = true
		f.emitBytes(out, len(thinkingOpenTag))
		return true
	}
	if f.inCode() {
		//! Markup inside a code span or fence is an example being shown, not a call.
		f.emitBytes(out, 1)
		return true
	}
	for i := range toolMarkupDialects {
		tags := &toolMarkupDialects[i]
		body, offset := "", 0
		switch {
		case strings.HasPrefix(f.buf, tags.callsOpen):
			body = trimMarkupSpace(f.buf[len(tags.callsOpen):])
			offset = len(f.buf) - len(body)
			if !strings.HasPrefix(body, tags.invokeOpen) {
				if !final && isPartialTag(body, tags.invokeOpen) {
					return false
				}
				f.emitBytes(out, 1)
				return true
			}
		case strings.HasPrefix(f.buf, tags.invokeOpen):
			body = f.buf
		case isPartialTag(f.buf, tags.callsOpen) || isPartialTag(f.buf, tags.invokeOpen):
			if !final {
				return false
			}
			continue
		default:
			continue
		}
		n, status := f.parseInvoke(body, tags)
		if status == markupComplete {
			f.runRaw.WriteString(f.buf[:offset+n])
			f.buf = f.buf[offset+n:]
			f.calls = tags
			return true
		}
		if status == markupNeedMore && !final {
			return false
		}
		f.emitBytes(out, 1)
		return true
	}
	if !final && isPartialTag(f.buf, thinkingOpenTag) {
		return false
	}
	f.emitBytes(out, 1)
	return true
}

// stepCalls consumes what follows a rescued invoke: more invokes, the closing wrapper,
// or formatting whitespace. Anything else ends the run and is scanned as ordinary text.
func (f *toolMarkupFilter) stepCalls(final bool) bool {
	tags := f.calls
	rest := trimMarkupSpace(f.buf)
	skipped := len(f.buf) - len(rest)
	switch {
	case strings.HasPrefix(rest, tags.callsClose):
		f.runRaw.WriteString(f.buf[:skipped+len(tags.callsClose)])
		f.buf = rest[len(tags.callsClose):]
		f.calls = nil
		return true
	case strings.HasPrefix(rest, tags.invokeOpen):
		n, status := f.parseInvoke(rest, tags)
		if status == markupComplete {
			f.runRaw.WriteString(f.buf[:skipped+n])
			f.buf = rest[n:]
			return true
		}
		if status == markupNeedMore && !final {
			return false
		}
	case rest == "":
		if !final {
			return false
		}
	case isPartialTag(rest, tags.callsClose) || isPartialTag(rest, tags.invokeOpen):
		if !final {
			return false
		}
	}
	f.calls = nil
	return true
}

// parseInvoke reads one complete <invoke> block for a declared tool at the start of s
// and records it. It returns the bytes consumed on success.
func (f *toolMarkupFilter) parseInvoke(s string, tags *toolMarkupTags) (int, markupParse) {
	name, pos, status := markupName(s, len(tags.invokeOpen))
	if status != markupComplete {
		return 0, status
	}
	paramTypes, declared := f.tools[name]
	if !declared {
		return 0, markupInvalid
	}
	input := make(map[string]interface{})
	for {
		rest := trimMarkupSpace(s[pos:])
		pos = len(s) - len(rest)
		switch {
		case strings.HasPrefix(rest, tags.invokeClose):
			f.run = append(f.run, KiroToolUse{Name: name, Input: input})
			return pos + len(tags.invokeClose), markupComplete
		case strings.HasPrefix(rest, tags.paramOpen):
			key, valueStart, status := markupName(rest, len(tags.paramOpen))
			if status != markupComplete {
				return 0, status
			}
			end := strings.Index(rest[valueStart:], tags.paramClose)
			if end < 0 {
				return 0, markupNeedMore
			}
			input[key] = coerceMarkupParam(rest[valueStart:valueStart+end], paramTypes[key])
			pos += valueStart + end + len(tags.paramClose)
		case isPartialTag(rest, tags.invokeClose) || isPartialTag(rest, tags.paramOpen):
			return 0, markupNeedMore
		default:
			return 0, markupInvalid
		}
	}
}

// markupName reads the quoted name that starts at s[start:] and ends with `">`.
func markupName(s string, start int) (string, int, markupParse) {
	rest := s[start:]
	end := strings.Index(rest, `">`)
	if end < 0 {
		pending := strings.TrimSuffix(rest, `"`)
		if len(pending) > maxMarkupNameLen || strings.ContainsAny(pending, "<>\"\n") {
			return "", 0, markupInvalid
		}
		return "", 0, markupNeedMore
	}
	name := rest[:end]
	if name == "" || len(name) > maxMarkupNameLen || strings.ContainsAny(name, "<>\"\n") {
		return "", 0, markupInvalid
	}
	return name, start + end + 2, markupComplete
}

func coerceMarkupParam(raw, schemaType string) interface{} {
	//! Claude's markup writes strings verbatim and every other type as JSON, so a declared
	//! string keeps its exact text and anything else is decoded when it parses.
	if schemaType == "string" {
		return raw
	}
	var value interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &value); err == nil {
		if _, isString := value.(string); !isString {
			return value
		}
	}
	return raw
}

func trimMarkupSpace(s string) string {
	return strings.TrimLeft(s, " \t\r\n")
}

// isPartialTag reports whether s could still grow into tag.
func isPartialTag(s, tag string) bool {
	return len(s) < len(tag) && strings.HasPrefix(tag, s)
}
