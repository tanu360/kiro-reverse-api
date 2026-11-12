package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	// maxStructuredScanBytes bounds the decoding work spent looking for JSON in one answer.
	maxStructuredScanBytes = 4 << 20
	maxSchemaErrors        = 5
	// maxSchemaRefHops bounds $ref hops taken without moving into the value, which ends cycles.
	maxSchemaRefHops = 32
	// maxSchemaSteps bounds the work of one validation over every anyOf/oneOf probe and every
	// $ref path together. Self-referencing or nested unions would otherwise cost 2^depth.
	maxSchemaSteps = 100_000
)

type jsonCandidate struct {
	text  string
	value interface{}
}

func decodeJSONNumbers(text string) (interface{}, bool) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var value interface{}
	if dec.Decode(&value) != nil {
		return nil, false
	}
	//! A second value after the first means the text is not one JSON value.
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	return value, true
}

// extractStructuredJSON returns the JSON value an answer carries: the whole answer (or the one
// fenced block it is) when that parses, else the last value in it that matches the schema,
// else the last value whose root type the schema allows, else the last value that parses.
// The text is returned as the model wrote it.
func extractStructuredJSON(text string, spec *structuredOutputSpec) (string, bool) {
	trimmed := strings.TrimSpace(text)
	whole := []string{trimmed}
	if inner, ok := stripOuterFence(trimmed); ok {
		whole = append(whole, inner)
	}
	for _, candidate := range whole {
		if value, ok := decodeJSONNumbers(candidate); ok && structuredRootAllowed(value, spec) {
			return candidate, true
		}
	}

	candidates := scanJSONValues(trimmed)
	fallback, fallbackTyped := "", false
	//! One budget for every candidate: a costly schema must not be paid once per bracket in prose.
	steps := maxSchemaSteps
	for i := len(candidates) - 1; i >= 0; i-- {
		candidate := candidates[i]
		if !structuredRootAllowed(candidate.value, spec) {
			continue
		}
		if spec == nil || spec.Schema == nil {
			return candidate.text, true
		}
		if errs, _ := validateJSONSchemaWithin(candidate.value, spec.Schema, spec.Strict, &steps); len(errs) == 0 {
			return candidate.text, true
		}
		//! A citation such as [1] after a near-miss object must not stand in for the answer.
		typed := jsonTypeMatches(candidate.value, spec.Schema["type"])
		if fallback == "" || (typed && !fallbackTyped) {
			fallback, fallbackTyped = candidate.text, typed
		}
	}
	return fallback, fallback != ""
}

func structuredRootAllowed(value interface{}, spec *structuredOutputSpec) bool {
	if spec != nil && spec.Kind == structuredOutputJSONObject {
		_, ok := value.(map[string]interface{})
		return ok
	}
	return true
}

// stripOuterFence unwraps an answer that is exactly one fenced code block.
func stripOuterFence(text string) (string, bool) {
	if !strings.HasPrefix(text, "```") {
		return "", false
	}
	newline := strings.IndexByte(text, '\n')
	if newline < 0 {
		return "", false
	}
	body := strings.TrimSpace(text[newline+1:])
	if !strings.HasSuffix(body, "```") {
		return "", false
	}
	return strings.TrimSpace(strings.TrimSuffix(body, "```")), true
}

// scanJSONValues lists the top-level objects and arrays in text, left to right.
func scanJSONValues(text string) []jsonCandidate {
	var found []jsonCandidate
	budget := maxStructuredScanBytes
	for i := 0; i < len(text) && budget > 0; {
		offset := strings.IndexAny(text[i:], "{[")
		if offset < 0 {
			break
		}
		start := i + offset
		reader := strings.NewReader(text[start:])
		dec := json.NewDecoder(reader)
		dec.UseNumber()
		var value interface{}
		err := dec.Decode(&value)
		budget -= int(reader.Size()) - reader.Len()
		switch {
		case err == nil:
			end := start + int(dec.InputOffset())
			found = append(found, jsonCandidate{text: text[start:end], value: value})
			i = end
		case errors.Is(err, io.ErrUnexpectedEOF):
			//! Valid JSON runs to the end of the answer unclosed: everything after start is part
			//! of one cut-off value, so nested pieces of it are not answers of their own.
			return found
		default:
			i = start + 1
		}
	}
	return found
}

// schemaRun is the state one validation shares with every anyOf/oneOf probe it starts.
type schemaRun struct {
	root   map[string]interface{}
	strict bool
	// steps is the work left; once it runs out the rest of the value goes unchecked.
	steps     *int
	exhausted bool
	// memo holds anyOf/oneOf branch results, so a recursive union visits each node once.
	memo map[schemaMemoKey]bool
}

type schemaMemoKey struct {
	schema  uintptr
	value   interface{}
	refHops int
}

// schemaValueRef stands in for an object or array in a memo key; the decoded value outlives
// the validation, so its address identifies it.
type schemaValueRef struct {
	array bool
	ptr   uintptr
	n     int
}

type schemaValidator struct {
	run *schemaRun
	// probe only needs a yes or no, so it stops at the first problem and formats none.
	probe bool
	errs  []string
}

// validateJSONSchema checks a value decoded with UseNumber against the common JSON Schema
// keywords: type, properties, required, enum, const, items, prefixItems, additionalProperties,
// anyOf, oneOf, allOf and local $ref. Other keywords are ignored. additionalProperties:false is
// enforced only when strict. It returns at most maxSchemaErrors problems.
func validateJSONSchema(value interface{}, schema map[string]interface{}, strict bool) []string {
	steps := maxSchemaSteps
	errs, _ := validateJSONSchemaWithin(value, schema, strict, &steps)
	return errs
}

// validateJSONSchemaWithin is validateJSONSchema drawing on a step budget the caller may share
// across values. complete is false when the budget ran out: the problems found up to then are
// real, and the part of the value left unchecked counts as matching.
func validateJSONSchemaWithin(value interface{}, schema map[string]interface{}, strict bool, steps *int) (errs []string, complete bool) {
	if schema == nil {
		return nil, true
	}
	run := &schemaRun{root: schema, strict: strict, steps: steps}
	v := &schemaValidator{run: run}
	v.check(value, schema, "$", 0)
	return v.errs, !run.exhausted
}

func (v *schemaValidator) stopped() bool {
	return len(v.errs) >= maxSchemaErrors || (v.probe && len(v.errs) > 0)
}

// spend takes n steps from the shared budget and reports whether the work may go ahead.
func (v *schemaValidator) spend(n int) bool {
	run := v.run
	if run.exhausted || *run.steps < n {
		run.exhausted = true
		*run.steps = 0
		return false
	}
	*run.steps -= n
	return true
}

func (v *schemaValidator) fail(path, format string, args ...interface{}) {
	if v.probe {
		if len(v.errs) == 0 {
			v.errs = append(v.errs, path)
		}
		return
	}
	if len(v.errs) < maxSchemaErrors {
		v.errs = append(v.errs, path+": "+fmt.Sprintf(format, args...))
	}
}

func (v *schemaValidator) matches(value interface{}, schema interface{}, refHops int) bool {
	branch, ok := schema.(map[string]interface{})
	if !ok {
		//! A boolean schema: true accepts everything, false nothing.
		allowed, isBool := schema.(bool)
		return !isBool || allowed
	}
	key, keyed := memoKeyFor(branch, value, refHops)
	if keyed {
		if result, seen := v.run.memo[key]; seen {
			return result
		}
	}
	probe := &schemaValidator{run: v.run, probe: true}
	probe.check(value, branch, "$", refHops)
	result := len(probe.errs) == 0
	if keyed && !v.run.exhausted {
		//! A probe cut short by the budget proves nothing, so only finished ones are kept.
		if v.run.memo == nil {
			v.run.memo = make(map[schemaMemoKey]bool)
		}
		v.run.memo[key] = result
	}
	return result
}

func memoKeyFor(schema map[string]interface{}, value interface{}, refHops int) (schemaMemoKey, bool) {
	key := schemaMemoKey{schema: reflect.ValueOf(schema).Pointer(), refHops: refHops}
	switch typed := value.(type) {
	case map[string]interface{}:
		key.value = schemaValueRef{ptr: reflect.ValueOf(typed).Pointer()}
	case []interface{}:
		key.value = schemaValueRef{array: true, ptr: reflect.ValueOf(typed).Pointer(), n: len(typed)}
	case string, json.Number, bool, float64, nil:
		key.value = value
	default:
		return key, false
	}
	return key, true
}

func (v *schemaValidator) check(value interface{}, schema map[string]interface{}, path string, refHops int) {
	if v.stopped() || refHops > maxSchemaRefHops || !v.spend(1) {
		return
	}
	if ref, ok := schema["$ref"].(string); ok {
		if target, ok := v.resolve(ref); ok {
			v.check(value, target, path, refHops+1)
		}
	}
	for _, keyword := range []string{"anyOf", "oneOf"} {
		branches, ok := schema[keyword].([]interface{})
		if !ok || len(branches) == 0 || v.stopped() {
			continue
		}
		matched := false
		for _, branch := range branches {
			if v.matches(value, branch, refHops) {
				matched = true
				break
			}
		}
		if !matched {
			v.fail(path, "does not match any allowed schema (%s)", keyword)
		}
	}
	if branches, ok := schema["allOf"].([]interface{}); ok {
		for _, branch := range branches {
			if sub, ok := branch.(map[string]interface{}); ok {
				v.check(value, sub, path, refHops)
			}
		}
	}
	if v.stopped() {
		return
	}
	if want, ok := schema["type"]; ok && !jsonTypeMatches(value, want) {
		v.fail(path, "expected %s, got %s", describeSchemaType(want), jsonTypeName(value))
		return
	}
	if options, ok := schema["enum"].([]interface{}); ok && v.spend(len(options)) {
		found := false
		for _, option := range options {
			if jsonValuesEqual(value, option) {
				found = true
				break
			}
		}
		if !found {
			v.fail(path, "must be one of %s", compactJSON(options))
		}
	}
	if want, ok := schema["const"]; ok && !jsonValuesEqual(value, want) {
		v.fail(path, "must equal %s", compactJSON(want))
	}
	if v.stopped() {
		return
	}

	switch typed := value.(type) {
	case map[string]interface{}:
		if v.spend(len(typed)) {
			v.checkObject(typed, schema, path)
		}
	case []interface{}:
		if v.spend(len(typed)) {
			v.checkArray(typed, schema, path)
		}
	}
}

func (v *schemaValidator) checkObject(object map[string]interface{}, schema map[string]interface{}, path string) {
	properties, _ := schema["properties"].(map[string]interface{})
	if required, ok := schema["required"].([]interface{}); ok {
		for _, name := range required {
			key, _ := name.(string)
			if _, present := object[key]; key != "" && !present {
				v.fail(path, "missing required property %q", key)
			}
		}
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if v.stopped() {
			return
		}
		child := jsonChildPath(path, key)
		if sub, ok := properties[key]; ok {
			if subSchema, ok := sub.(map[string]interface{}); ok {
				v.check(object[key], subSchema, child, 0)
			} else if allowed, isBool := sub.(bool); isBool && !allowed {
				v.fail(child, "property is not allowed")
			}
			continue
		}
		switch extra := schema["additionalProperties"].(type) {
		case bool:
			if !extra && v.run.strict {
				v.fail(path, "unexpected property %q", key)
			}
		case map[string]interface{}:
			v.check(object[key], extra, child, 0)
		}
	}
}

func (v *schemaValidator) checkArray(items []interface{}, schema map[string]interface{}, path string) {
	prefix, _ := schema["prefixItems"].([]interface{})
	if tuple, ok := schema["items"].([]interface{}); ok && prefix == nil {
		//! Draft 4-7 tuple form of items.
		prefix = tuple
	}
	for i, item := range items {
		if v.stopped() {
			return
		}
		child := path + "[" + strconv.Itoa(i) + "]"
		if i < len(prefix) {
			if sub, ok := prefix[i].(map[string]interface{}); ok {
				v.check(item, sub, child, 0)
			}
			continue
		}
		if sub, ok := schema["items"].(map[string]interface{}); ok {
			v.check(item, sub, child, 0)
		}
	}
}

// resolve follows a local reference such as #/$defs/name; remote references are not checked.
func (v *schemaValidator) resolve(ref string) (map[string]interface{}, bool) {
	if ref == "#" {
		return v.run.root, true
	}
	if !strings.HasPrefix(ref, "#/") {
		return nil, false
	}
	var node interface{} = v.run.root
	for _, part := range strings.Split(ref[2:], "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		switch typed := node.(type) {
		case map[string]interface{}:
			node = typed[part]
		case []interface{}:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(typed) {
				return nil, false
			}
			node = typed[index]
		default:
			return nil, false
		}
	}
	target, ok := node.(map[string]interface{})
	return target, ok
}

func jsonTypeMatches(value interface{}, want interface{}) bool {
	switch typed := want.(type) {
	case string:
		return jsonTypeIs(value, typed)
	case []interface{}:
		for _, option := range typed {
			if name, ok := option.(string); ok && jsonTypeIs(value, name) {
				return true
			}
		}
		return false
	}
	return true
}

func jsonTypeIs(value interface{}, name string) bool {
	switch name {
	case "object":
		_, ok := value.(map[string]interface{})
		return ok
	case "array":
		_, ok := value.([]interface{})
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "null":
		return value == nil
	case "number":
		_, ok := jsonNumberValue(value)
		return ok
	case "integer":
		number, ok := jsonNumberValue(value)
		return ok && !math.IsInf(number, 0) && number == math.Trunc(number)
	}
	return true
}

func jsonNumberValue(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case float64:
		return typed, true
	}
	return 0, false
}

func jsonTypeName(value interface{}) string {
	switch value.(type) {
	case map[string]interface{}:
		return "object"
	case []interface{}:
		return "array"
	case string:
		return "string"
	case bool:
		return "boolean"
	case nil:
		return "null"
	}
	if number, ok := jsonNumberValue(value); ok {
		if number == math.Trunc(number) {
			return "integer"
		}
		return "number"
	}
	return "unknown"
}

func describeSchemaType(want interface{}) string {
	if list, ok := want.([]interface{}); ok {
		names := make([]string, 0, len(list))
		for _, option := range list {
			if name, ok := option.(string); ok {
				names = append(names, name)
			}
		}
		return strings.Join(names, " or ")
	}
	name, _ := want.(string)
	return name
}

func jsonValuesEqual(a, b interface{}) bool {
	if left, ok := jsonNumberValue(a); ok {
		right, ok := jsonNumberValue(b)
		return ok && left == right
	}
	switch left := a.(type) {
	case map[string]interface{}:
		right, ok := b.(map[string]interface{})
		if !ok || len(left) != len(right) {
			return false
		}
		for key, value := range left {
			other, present := right[key]
			if !present || !jsonValuesEqual(value, other) {
				return false
			}
		}
		return true
	case []interface{}:
		right, ok := b.([]interface{})
		if !ok || len(left) != len(right) {
			return false
		}
		for i := range left {
			if !jsonValuesEqual(left[i], right[i]) {
				return false
			}
		}
		return true
	}
	return a == b
}

func compactJSON(value interface{}) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	if len(raw) > 200 {
		return string(raw[:200]) + "..."
	}
	return string(raw)
}

var plainJSONKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func jsonChildPath(path, key string) string {
	if plainJSONKey.MatchString(key) {
		return path + "." + key
	}
	return path + "[" + strconv.Quote(key) + "]"
}
