package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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
// else the last value that parses. The text is returned as the model wrote it.
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
	parsed := ""
	for i := len(candidates) - 1; i >= 0; i-- {
		candidate := candidates[i]
		if !structuredRootAllowed(candidate.value, spec) {
			continue
		}
		if parsed == "" {
			parsed = candidate.text
		}
		if spec == nil || spec.Schema == nil || len(validateJSONSchema(candidate.value, spec.Schema, spec.Strict)) == 0 {
			return candidate.text, true
		}
	}
	return parsed, parsed != ""
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

type schemaValidator struct {
	root   map[string]interface{}
	strict bool
	errs   []string
}

// validateJSONSchema checks a value decoded with UseNumber against the common JSON Schema
// keywords: type, properties, required, enum, const, items, prefixItems, additionalProperties,
// anyOf, oneOf, allOf and local $ref. Other keywords are ignored. additionalProperties:false is
// enforced only when strict. It returns at most maxSchemaErrors problems.
func validateJSONSchema(value interface{}, schema map[string]interface{}, strict bool) []string {
	if schema == nil {
		return nil
	}
	v := &schemaValidator{root: schema, strict: strict}
	v.check(value, schema, "$", 0)
	return v.errs
}

func (v *schemaValidator) fail(path, format string, args ...interface{}) {
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
	probe := &schemaValidator{root: v.root, strict: v.strict}
	probe.check(value, branch, "$", refHops)
	return len(probe.errs) == 0
}

func (v *schemaValidator) check(value interface{}, schema map[string]interface{}, path string, refHops int) {
	if len(v.errs) >= maxSchemaErrors || refHops > maxSchemaRefHops {
		return
	}
	if ref, ok := schema["$ref"].(string); ok {
		if target, ok := v.resolve(ref); ok {
			v.check(value, target, path, refHops+1)
		}
	}
	for _, keyword := range []string{"anyOf", "oneOf"} {
		branches, ok := schema[keyword].([]interface{})
		if !ok || len(branches) == 0 {
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
	if want, ok := schema["type"]; ok && !jsonTypeMatches(value, want) {
		v.fail(path, "expected %s, got %s", describeSchemaType(want), jsonTypeName(value))
		return
	}
	if options, ok := schema["enum"].([]interface{}); ok {
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

	switch typed := value.(type) {
	case map[string]interface{}:
		v.checkObject(typed, schema, path)
	case []interface{}:
		v.checkArray(typed, schema, path)
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
			if !extra && v.strict {
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
		return v.root, true
	}
	if !strings.HasPrefix(ref, "#/") {
		return nil, false
	}
	var node interface{} = v.root
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
