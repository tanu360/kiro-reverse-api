package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func decodeClaudeRequestForTest(t *testing.T, body string) *ClaudeRequest {
	t.Helper()
	var req ClaudeRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	return &req
}

const personSchema = `{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer"}},"required":["name","age"],"additionalProperties":false}`

func TestStructuredOutputParseClaudeFormat(t *testing.T) {
	for _, tc := range []struct {
		name     string
		body     string
		wantErr  string
		wantSpec bool
		wantProp string
	}{
		{name: "no format", body: `{"output_config":{"effort":"high"}}`},
		{name: "output_config.format", body: `{"output_config":{"format":{"type":"json_schema","schema":` + personSchema + `}}}`, wantSpec: true, wantProp: "age"},
		{name: "beta alias", body: `{"output_format":{"type":"json_schema","schema":{"type":"object","properties":{"beta":{"type":"string"}}}}}`, wantSpec: true, wantProp: "beta"},
		{name: "output_config wins", body: `{"output_format":{"type":"json_schema","schema":{"properties":{"beta":{}}}},"output_config":{"format":{"type":"json_schema","schema":{"properties":{"ga":{}}}}}}`, wantSpec: true, wantProp: "ga"},
		{name: "null format", body: `{"output_config":{"format":null}}`},
		{name: "bad type", body: `{"output_config":{"format":{"type":"json_object"}}}`, wantErr: "unsupported output_config.format type: json_object"},
		{name: "missing schema", body: `{"output_config":{"format":{"type":"json_schema"}}}`, wantErr: "output_config.format.schema is required"},
		{name: "schema not an object", body: `{"output_format":{"type":"json_schema","schema":"x"}}`, wantErr: "output_format.schema must be an object"},
		{name: "format not an object", body: `{"output_config":{"format":"json"}}`, wantErr: "output_config.format must be an object"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec, msg := parseClaudeStructuredOutput(decodeClaudeRequestForTest(t, tc.body))
			if msg != tc.wantErr {
				t.Fatalf("error = %q, want %q", msg, tc.wantErr)
			}
			if (spec != nil) != tc.wantSpec {
				t.Fatalf("spec = %#v, want present=%t", spec, tc.wantSpec)
			}
			if spec == nil {
				return
			}
			if spec.Kind != structuredOutputJSONSchema || !spec.Strict {
				t.Fatalf("spec = %#v, want a strict json_schema", spec)
			}
			if properties, _ := spec.Schema["properties"].(map[string]interface{}); properties[tc.wantProp] == nil {
				t.Fatalf("schema = %#v, want property %q", spec.Schema, tc.wantProp)
			}
		})
	}

	req := decodeClaudeRequestForTest(t, `{"model":"m","messages":[{"role":"user","content":"hi"}],"output_config":{"format":{"type":"text"}}}`)
	if msg := validateClaudeRequestShape(req); msg != "unsupported output_config.format type: text" {
		t.Fatalf("request validation = %q, want the format error", msg)
	}
}

func TestStructuredOutputParseChatResponseFormat(t *testing.T) {
	for _, tc := range []struct {
		name       string
		raw        string
		wantErr    string
		wantKind   string
		wantStrict bool
		wantSchema bool
	}{
		{name: "absent"},
		{name: "text", raw: `{"type":"text"}`},
		{name: "json_object", raw: `{"type":"json_object"}`, wantKind: structuredOutputJSONObject},
		{name: "json_schema strict", raw: `{"type":"json_schema","json_schema":{"name":"person","strict":true,"schema":` + personSchema + `}}`, wantKind: structuredOutputJSONSchema, wantStrict: true, wantSchema: true},
		{name: "json_schema loose", raw: `{"type":"json_schema","json_schema":{"name":"person","schema":` + personSchema + `}}`, wantKind: structuredOutputJSONSchema, wantSchema: true},
		{name: "json_schema without schema", raw: `{"type":"json_schema","json_schema":{"name":"any"}}`, wantKind: structuredOutputJSONSchema},
		{name: "unsupported type", raw: `{"type":"xml"}`, wantErr: "unsupported response_format type: xml"},
		{name: "schema not an object", raw: `{"type":"json_schema","json_schema":{"schema":[1]}}`, wantErr: "response_format.json_schema.schema must be an object"},
		{name: "json_schema not an object", raw: `{"type":"json_schema","json_schema":"person"}`, wantErr: "response_format.json_schema must be an object"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec, msg := parseChatResponseFormat(json.RawMessage(tc.raw))
			if msg != tc.wantErr {
				t.Fatalf("error = %q, want %q", msg, tc.wantErr)
			}
			if tc.wantKind == "" {
				if spec != nil {
					t.Fatalf("spec = %#v, want none", spec)
				}
				return
			}
			if spec == nil || spec.Kind != tc.wantKind || spec.Strict != tc.wantStrict || (spec.Schema != nil) != tc.wantSchema {
				t.Fatalf("spec = %#v", spec)
			}
		})
	}

	var req OpenAIRequest
	if err := json.Unmarshal([]byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"response_format":{"type":"xml"}}`), &req); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg := validateOpenAIRequestShape(&req); msg != "unsupported response_format type: xml" {
		t.Fatalf("request validation = %q, want the 400 message", msg)
	}
}

func TestStructuredOutputParseResponsesTextFormat(t *testing.T) {
	var req OpenAIResponsesRequest
	body := `{"model":"m","input":"hi","text":{"format":{"type":"json_schema","name":"ordered","strict":true,"schema":{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"string"}}}}}}`
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("decode: %v", err)
	}
	spec, msg := parseResponsesTextFormat(req.Text)
	if msg != "" || spec == nil || spec.Name != "ordered" || !spec.Strict {
		t.Fatalf("spec = %#v msg=%q", spec, msg)
	}
	if strings.Index(spec.SchemaText, "zeta") > strings.Index(spec.SchemaText, "alpha") {
		t.Fatalf("schema text lost the client's key order:\n%s", spec.SchemaText)
	}
	if _, msg := parseResponsesTextFormat(&OpenAIResponsesText{Format: map[string]interface{}{"type": "yaml"}}); msg != "unsupported text.format type: yaml" {
		t.Fatalf("unsupported type message = %q", msg)
	}
}

func TestStructuredOutputSchemaTooLarge(t *testing.T) {
	huge := strings.Repeat("x", maxStructuredSchemaBytes)
	raw := `{"type":"json_schema","json_schema":{"schema":{"type":"object","description":"` + huge + `"}}}`
	if _, msg := parseChatResponseFormat(json.RawMessage(raw)); !strings.Contains(msg, "too large") {
		t.Fatalf("error = %q, want a size error", msg)
	}
	req := decodeClaudeRequestForTest(t, `{"output_config":{"format":{"type":"json_schema","schema":{"description":"`+huge+`"}}}}`)
	if msg := validateClaudeStructuredOutput(req); !strings.Contains(msg, "output_config.format.schema is too large") {
		t.Fatalf("error = %q, want a size error", msg)
	}
}

func TestStructuredOutputInjectsIntoPriming(t *testing.T) {
	req := decodeClaudeRequestForTest(t, `{"model":"claude-sonnet-4.5","system":"Be terse.","messages":[{"role":"user","content":"Who?"}],
		"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"string"}},"required":["zeta"]}}}}`)
	payload := ClaudeToKiro(req, false)
	before := len(payload.ConversationState.History)
	attachStructuredOutput(payload, claudeStructuredOutputSpec(req), false)

	history := payload.ConversationState.History
	if len(history) != before || before != 2 {
		t.Fatalf("history = %d turns (was %d), want the existing priming pair reused", len(history), before)
	}
	priming := history[0].UserInputMessage.Content
	if !strings.HasPrefix(priming, "Be terse.") || !strings.Contains(priming, "JSON schema:\n{") {
		t.Fatalf("priming = %q, want the system text then the schema", priming)
	}
	if !strings.Contains(priming, "Do not add properties the schema does not define.") {
		t.Fatalf("priming = %q, want the strict rule for Anthropic formats", priming)
	}
	if strings.Index(priming, `"zeta"`) > strings.Index(priming, `"alpha"`) {
		t.Fatalf("schema key order changed:\n%s", priming)
	}
	if history[1].AssistantResponseMessage.Content != structuredPrimingAck {
		t.Fatalf("priming reply = %q", history[1].AssistantResponseMessage.Content)
	}
}

func TestStructuredOutputCreatesPrimingWithoutSystem(t *testing.T) {
	req := &OpenAIRequest{Model: "claude-sonnet-4.5", Messages: []OpenAIMessage{
		{Role: "user", Content: "first"},
		{Role: "assistant", Content: "reply"},
		{Role: "user", Content: "second"},
	}}
	payload := OpenAIToKiro(req, false)
	if len(payload.ConversationState.History) != 2 {
		t.Fatalf("setup: history = %#v", payload.ConversationState.History)
	}
	attachStructuredOutput(payload, &structuredOutputSpec{Kind: structuredOutputJSONObject}, false)

	got := kiroTurnTexts(payload)
	if len(got) != 5 {
		t.Fatalf("turns = %q, want a new priming pair before the conversation", got)
	}
	if !strings.HasPrefix(got[0], "Respond only with a single valid JSON object.") || got[1] != structuredPrimingAck {
		t.Fatalf("priming = %q / %q", got[0], got[1])
	}
	if got[2] != "first" || got[3] != "reply" {
		t.Fatalf("conversation = %q, want it unchanged after the priming pair", got[2:4])
	}
}

func TestStructuredOutputAddsCurrentTurnReminder(t *testing.T) {
	req := &OpenAIRequest{Model: "claude-sonnet-4.5", Messages: []OpenAIMessage{{Role: "user", Content: "List two colours."}}}
	payload := OpenAIToKiro(req, false)
	spec := &structuredOutputSpec{Kind: structuredOutputJSONSchema, Schema: map[string]interface{}{"type": "array"}, SchemaText: `{"type": "array"}`}
	attachStructuredOutput(payload, spec, true)

	current := payload.ConversationState.CurrentMessage.UserInputMessage.Content
	if current != "List two colours.\n\n"+structuredOutputReminder(spec) {
		t.Fatalf("current turn = %q", current)
	}
	if payload.StructuredOutput == nil || !payload.StructuredOutput.Stream || spec.Stream {
		t.Fatalf("payload spec = %#v, want a stream-marked copy that leaves the caller's spec alone", payload.StructuredOutput)
	}
	raw, _ := json.Marshal(payload)
	if strings.Contains(string(raw), "StructuredOutput") || strings.Contains(string(raw), "SchemaText") {
		t.Fatalf("the spec must never reach the upstream body: %s", raw)
	}
}

func TestStructuredOutputNoFieldLeavesPayloadUnchanged(t *testing.T) {
	req := decodeClaudeRequestForTest(t, `{"model":"claude-sonnet-4.5","system":"S","messages":[{"role":"user","content":"hi"}],"output_config":{"effort":"low"}}`)
	payload := ClaudeToKiro(req, false)
	before, _ := json.Marshal(payload)
	attachStructuredOutput(payload, claudeStructuredOutputSpec(req), false)
	after, _ := json.Marshal(payload)
	if string(before) != string(after) || payload.StructuredOutput != nil {
		t.Fatalf("payload changed without a format field:\n%s\n%s", before, after)
	}

	initStructuredConfigForTest(t)
	script := &scriptedKiro{hops: []scriptedHop{{text: []string{"```json\n{\"a\":1}\n```"}, stop: "end_turn"}}}
	rec := &continueRecorder{}
	if err := callKiroAutoContinue(t.Context(), nil, payload, rec.callback(), script.call); err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 1 || rec.text != "```json\n{\"a\":1}\n```" {
		t.Fatalf("calls=%d text=%q, want one untouched pass-through call", len(script.payloads), rec.text)
	}
}

func TestExtractStructuredJSONFromMessyText(t *testing.T) {
	object := &structuredOutputSpec{Kind: structuredOutputJSONObject}
	anyValue := &structuredOutputSpec{Kind: structuredOutputJSONSchema}
	person := &structuredOutputSpec{Kind: structuredOutputJSONSchema, Strict: true, Schema: mustSchema(personSchema)}
	for _, tc := range []struct {
		name string
		text string
		spec *structuredOutputSpec
		want string
		ok   bool
	}{
		{"plain", ` {"a":1} `, object, `{"a":1}`, true},
		{"json fence", "```json\n{\"a\": 1}\n```", object, `{"a": 1}`, true},
		{"bare fence", "```\n[1, 2]\n```", anyValue, `[1, 2]`, true},
		{"prose around", "Sure! Here it is:\n{\"name\":\"Ann\",\"age\":30}\nAnything else?", person, `{"name":"Ann","age":30}`, true},
		{"fence inside prose", "Result:\n```json\n{\"name\":\"Bo\",\"age\":4}\n```\nDone.", person, `{"name":"Bo","age":4}`, true},
		{"braces in prose", "Use {name} and {age} as fields: {\"name\":\"Cy\",\"age\":5}", person, `{"name":"Cy","age":5}`, true},
		{"braces inside strings", `Answer: {"name":"a } { b","age":1} ok`, person, `{"name":"a } { b","age":1}`, true},
		{"two objects take the last", `{"name":"Old","age":1} then corrected {"name":"New","age":2}`, person, `{"name":"New","age":2}`, true},
		{"last valid beats a later invalid", `{"name":"Good","age":3} and also {"name":"bad"}`, person, `{"name":"Good","age":3}`, true},
		{"nothing valid validates", `draft {"name":"x"}`, person, `{"name":"x"}`, true},
		{"citation after a near miss", `{"name":"Ann"} (see [1])`, person, `{"name":"Ann"}`, true},
		{"no root type match takes the last", `[1] then [2]`, person, `[2]`, true},
		{"array root for json_object", "[1,2]", object, "", false},
		{"array root", "The list: [\"a\", \"b\"].", anyValue, `["a", "b"]`, true},
		{"scalar root whole text", `"just a string"`, anyValue, `"just a string"`, true},
		{"scalar in prose is ignored", `The answer is 42.`, anyValue, "", false},
		{"nothing", "I cannot help with that.", object, "", false},
		{"truncated", `Here: {"name":"Ann","age":30} and {"name":"Bo","ag`, person, `{"name":"Ann","age":30}`, true},
		{"truncated only", `{"name":"Ann","details":{"x":1},"age":`, person, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := extractStructuredJSON(tc.text, tc.spec)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("extract(%q) = %q, %t; want %q, %t", tc.text, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func mustSchema(raw string) map[string]interface{} {
	var schema map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &schema); err != nil {
		panic(err)
	}
	return schema
}

func TestValidateJSONSchema(t *testing.T) {
	defs := `{"$defs":{"tag":{"type":"string","enum":["red","blue"]}},"type":"object","properties":{"tags":{"type":"array","items":{"$ref":"#/$defs/tag"}}}}`
	for _, tc := range []struct {
		name   string
		schema string
		value  string
		strict bool
		want   []string
	}{
		{"valid", personSchema, `{"name":"a","age":3}`, true, nil},
		{"wrong type", personSchema, `{"name":1,"age":3}`, true, []string{"$.name: expected string, got integer"}},
		{"integer rejects fraction", personSchema, `{"name":"a","age":3.5}`, true, []string{"$.age: expected integer, got number"}},
		{"integer accepts 2.0", personSchema, `{"name":"a","age":2.0}`, true, nil},
		{"required", personSchema, `{"name":"a"}`, true, []string{`$: missing required property "age"`}},
		{"strict extra property", personSchema, `{"name":"a","age":1,"x":0}`, true, []string{`$: unexpected property "x"`}},
		{"loose extra property", personSchema, `{"name":"a","age":1,"x":0}`, false, nil},
		{"additionalProperties schema", `{"type":"object","additionalProperties":{"type":"number"}}`, `{"a":1,"b":"x"}`, false, []string{"$.b: expected number, got string"}},
		{"enum", `{"enum":["a","b",3]}`, `"c"`, false, []string{`$: must be one of ["a","b",3]`}},
		{"enum number", `{"enum":["a",3]}`, `3.0`, false, nil},
		{"const", `{"const":{"k":[1]}}`, `{"k":[1]}`, false, nil},
		{"const mismatch", `{"const":"x"}`, `"y"`, false, []string{`$: must equal "x"`}},
		{"nested items", `{"type":"array","items":{"type":"object","required":["id"]}}`, `[{"id":1},{"x":2}]`, false, []string{`$[1]: missing required property "id"`}},
		{"anyOf", `{"anyOf":[{"type":"string"},{"type":"integer"}]}`, `true`, false, []string{"$: does not match any allowed schema (anyOf)"}},
		{"anyOf match", `{"anyOf":[{"type":"string"},{"type":"integer"}]}`, `7`, false, nil},
		{"ref and defs", defs, `{"tags":["red","green"]}`, false, []string{`$.tags[1]: must be one of ["red","blue"]`}},
		{"nullable type list", `{"type":["string","null"]}`, `null`, false, nil},
		{"type list mismatch", `{"type":["string","null"]}`, `1`, false, []string{"$: expected string or null, got integer"}},
		{"odd key path", `{"type":"object","properties":{"a b":{"type":"string"}}}`, `{"a b":1}`, false, []string{`$["a b"]: expected string, got integer`}},
		{"remote ref ignored", `{"$ref":"https://example.com/s.json"}`, `{"any":1}`, false, nil},
		{"recursive ref terminates", `{"$ref":"#"}`, `1`, false, nil},
		{"tree ref", `{"type":"object","properties":{"child":{"$ref":"#"},"v":{"type":"integer"}}}`, `{"child":{"child":{"v":"x"}}}`, false, []string{"$.child.child.v: expected integer, got string"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value, ok := decodeJSONNumbers(tc.value)
			if !ok {
				t.Fatalf("bad test value %q", tc.value)
			}
			got := validateJSONSchema(value, mustSchema(tc.schema), tc.strict)
			if strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Fatalf("errors = %q, want %q", got, tc.want)
			}
		})
	}

	many := validateJSONSchema(map[string]interface{}{}, mustSchema(`{"required":["a","b","c","d","e","f","g"]}`), false)
	if len(many) != maxSchemaErrors {
		t.Fatalf("errors = %d, want the cap of %d", len(many), maxSchemaErrors)
	}
}

func TestValidateJSONSchemaBoundedWork(t *testing.T) {
	one, _ := decodeJSONNumbers(`1`)
	for _, tc := range []struct {
		name     string
		schema   string
		value    interface{}
		want     []string
		complete bool
	}{
		//! The cycle ends at maxSchemaRefHops, so the check reports itself incomplete.
		{"self-referencing anyOf", `{"anyOf":[{"$ref":"#"},{"$ref":"#"}],"type":"string"}`, one,
			[]string{"$: does not match any allowed schema (anyOf)", "$: expected string, got integer"}, false},
		{"anyOf chain past the $ref hop cap", refChainSchema(maxSchemaRefHops + 8), one, nil, false},
		{"anyOf chain within the $ref hop cap", refChainSchema(maxSchemaRefHops / 2), one,
			[]string{"$: does not match any allowed schema (anyOf)"}, true},
		{"self-referencing allOf", `{"allOf":[{"$ref":"#"},{"$ref":"#"}]}`, one, nil, false},
		{"recursive union tree", treeUnionSchema, treeUnionValue(40, "b"), nil, true},
		{"recursive union tree, bad leaf", treeUnionSchema, treeUnionValue(40, "c"),
			[]string{"$: does not match any allowed schema (anyOf)"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			steps := maxSchemaSteps
			done := make(chan struct{})
			var got []string
			var complete bool
			go func() {
				defer close(done)
				got, complete = validateJSONSchemaWithin(tc.value, mustSchema(tc.schema), false, &steps)
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatalf("validation still running after 5s")
			}
			if strings.Join(got, "|") != strings.Join(tc.want, "|") || complete != tc.complete {
				t.Fatalf("errors = %q complete = %t, want %q %t", got, complete, tc.want, tc.complete)
			}
		})
	}

	//! A spent budget leaves every later candidate unchecked rather than paying again per candidate.
	spent := 0
	if errs, complete := validateJSONSchemaWithin(one, mustSchema(`{"type":"string"}`), false, &spent); errs != nil || complete {
		t.Fatalf("errs=%q complete=%t, want an unchecked value with no budget", errs, complete)
	}
}

// refChainSchema is a chain of n anyOf unions, each a $ref to the next, ending in a string.
func refChainSchema(n int) string {
	defs := make([]string, 0, n+1)
	for i := 0; i < n; i++ {
		next := fmt.Sprintf(`{"$ref":"#/$defs/d%d"}`, i+1)
		defs = append(defs, fmt.Sprintf(`"d%d":{"anyOf":[%s,%s]}`, i, next, next))
	}
	defs = append(defs, fmt.Sprintf(`"d%d":{"type":"string"}`, n))
	return `{"$ref":"#/$defs/d0","$defs":{` + strings.Join(defs, ",") + `}}`
}

// treeUnionSchema is a discriminated union whose children recurse into the root schema.
const treeUnionSchema = `{"anyOf":[
	{"type":"object","properties":{"kind":{"const":"a"},"children":{"type":"array","items":{"$ref":"#"}}},"required":["kind"]},
	{"type":"object","properties":{"kind":{"const":"b"},"children":{"type":"array","items":{"$ref":"#"}}},"required":["kind"]}]}`

// treeUnionValue nests depth "b" nodes and ends in a leaf of the given kind.
func treeUnionValue(depth int, leafKind string) interface{} {
	var node interface{} = map[string]interface{}{"kind": leafKind}
	for i := 0; i < depth; i++ {
		node = map[string]interface{}{"kind": "b", "children": []interface{}{node}}
	}
	return node
}

func TestJSONFenceStripperStream(t *testing.T) {
	for _, tc := range []struct {
		name   string
		chunks []string
		want   string
	}{
		{"no fence", []string{`{"a":`, `1}`}, `{"a":1}`},
		{"fence in one chunk", []string{"```json\n{\"a\":1}\n```"}, "{\"a\":1}\n"},
		{"fence split across chunks", []string{"`", "``js", "on\n{\"a\"", ":1}\n``", "`\n"}, "{\"a\":1}\n"},
		{"bare fence and leading blank", []string{"\n\n```\n", "[1,2]\n```"}, "[1,2]\n"},
		{"upper-case language", []string{"```JSON\n{}\n```"}, "{}\n"},
		{"python fence passes through", []string{"```python\nprint(1)\n```"}, "```python\nprint(1)\n```"},
		{"prose passes through", []string{"Sure", ": ```json\n{}\n```"}, "Sure: ```json\n{}\n```"},
		{"backticks inside strings", []string{"```json\n{\"code\":\"", "```", "\"}\n```"}, "{\"code\":\"```\"}\n"},
		{"text after closing fence", []string{"```json\n{}\n```\nDone."}, "{}\nDone."},
		{"closing fence without newline at end", []string{"```json\n{}\n", "```"}, "{}\n"},
		{"thinking before fence", []string{"<thin", "king>plan ``` x</thi", "nking>\n```json\n{}\n```"}, "<thinking>plan ``` x</thinking>{}\n"},
		{"only whitespace", []string{"  \n"}, "  \n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stripper jsonFenceStripper
			var got strings.Builder
			for _, chunk := range tc.chunks {
				got.WriteString(stripper.Push(chunk))
			}
			got.WriteString(stripper.Flush())
			if got.String() != tc.want {
				t.Fatalf("stripped = %q, want %q", got.String(), tc.want)
			}
		})
	}
}
