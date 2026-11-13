package config

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	// MaxResponseHeaders caps the custom response header list.
	MaxResponseHeaders = 20

	maxResponseHeaderNameLen  = 128
	maxResponseHeaderValueLen = 512
)

// ResponseHeaderVariables are the {name} placeholders a header value may use, in the order the
// admin UI offers them.
var ResponseHeaderVariables = []string{"request_id", "model", "account_id", "key_id", "client_ip"}

// ResponseHeaderRule is one custom header added to every client API response. Value is a
// template: {request_id}, {model}, {account_id}, {key_id} and {client_ip} are filled in when the
// response starts.
type ResponseHeaderRule struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

var ErrInvalidResponseHeader = errors.New("invalid response header")

// ResponseHeaderError names the rejected entry; Index is -1 when the list as a whole is invalid.
// Code and Params are what the admin UI translates; Reason is the English text.
type ResponseHeaderError struct {
	Index  int
	Reason string
	Code   string
	Params map[string]interface{}
}

func (e *ResponseHeaderError) Error() string { return e.Reason }

func (e *ResponseHeaderError) Unwrap() error { return ErrInvalidResponseHeader }

func invalidResponseHeader(index int, code string, params map[string]interface{}, format string, args ...interface{}) error {
	return &ResponseHeaderError{Index: index, Reason: fmt.Sprintf(format, args...), Code: code, Params: params}
}

// forbiddenResponseHeaders are refused by name: hop-by-hop and framing headers belong to
// net/http, Date to the server, and Set-Cookie could overwrite the admin session cookie on the
// same origin. Access-Control-* is refused by prefix.
var forbiddenResponseHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-connection":    true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"http2-settings":      true,
	"content-length":      true,
	"content-type":        true,
	"content-encoding":    true,
	"content-range":       true,
	"date":                true,
	"set-cookie":          true,
}

const forbiddenResponseHeaderPrefix = "access-control-"

// GetResponseHeaders returns a copy of the configured list (empty, never nil).
func GetResponseHeaders() []ResponseHeaderRule {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || len(cfg.ResponseHeaders) == 0 {
		return []ResponseHeaderRule{}
	}
	return append([]ResponseHeaderRule(nil), cfg.ResponseHeaders...)
}

// ActiveResponseHeaders returns the enabled headers that are safe to send. Saved lists are
// validated already; the check here covers a config restored or edited by hand.
func ActiveResponseHeaders() []ResponseHeaderRule {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || len(cfg.ResponseHeaders) == 0 {
		return nil
	}
	var active []ResponseHeaderRule
	for _, rule := range cfg.ResponseHeaders {
		if !rule.Enabled || responseHeaderNameCode(rule.Name) != "" || responseHeaderValueCode(rule.Value) != "" {
			continue
		}
		active = append(active, rule)
	}
	return active
}

// UpdateResponseHeaders validates and saves the whole list. It assigns a new slice, so copies
// taken by Get and the backup snapshot never see it change.
func UpdateResponseHeaders(rules []ResponseHeaderRule) error {
	cleaned, err := normalizeResponseHeaders(rules)
	if err != nil {
		return err
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.ResponseHeaders = cleaned
	return Save()
}

func normalizeResponseHeaders(rules []ResponseHeaderRule) ([]ResponseHeaderRule, error) {
	if len(rules) > MaxResponseHeaders {
		return nil, invalidResponseHeader(-1, "response_headers_too_many", map[string]interface{}{"max": MaxResponseHeaders}, "at most %d response headers are allowed", MaxResponseHeaders)
	}
	cleaned := make([]ResponseHeaderRule, 0, len(rules))
	for i, rule := range rules {
		//! Only spaces and tabs are trimmed: a CR or LF anywhere is refused, not quietly dropped.
		name := strings.Trim(rule.Name, " \t")
		value := strings.Trim(rule.Value, " \t")
		if code := responseHeaderNameCode(name); code != "" {
			return nil, responseHeaderNameError(i, code, name)
		}
		for _, previous := range cleaned {
			if strings.EqualFold(previous.Name, name) {
				return nil, invalidResponseHeader(i, "response_header_name_duplicate", map[string]interface{}{"name": name}, "header %q is listed more than once", name)
			}
		}
		if code := responseHeaderValueCode(value); code != "" {
			return nil, responseHeaderValueError(i, code, name)
		}
		if unknown := unknownResponseHeaderVariable(value); unknown != "" {
			return nil, invalidResponseHeader(i, "response_header_unknown_variable", map[string]interface{}{"variable": unknown}, "header %q uses unknown variable {%s}", name, unknown)
		}
		cleaned = append(cleaned, ResponseHeaderRule{Name: name, Value: value, Enabled: rule.Enabled})
	}
	return cleaned, nil
}

func responseHeaderNameError(index int, code, name string) error {
	switch code {
	case "response_header_name_empty":
		return invalidResponseHeader(index, code, nil, "header %d has no name", index+1)
	case "response_header_name_too_long":
		return invalidResponseHeader(index, code, map[string]interface{}{"max": maxResponseHeaderNameLen}, "header name is longer than %d characters", maxResponseHeaderNameLen)
	case "response_header_name_forbidden":
		return invalidResponseHeader(index, code, map[string]interface{}{"name": name}, "header %q is managed by the proxy and cannot be set", name)
	default:
		return invalidResponseHeader(index, code, map[string]interface{}{"name": name}, "header name %q is not a valid HTTP token", name)
	}
}

func responseHeaderValueError(index int, code, name string) error {
	switch code {
	case "response_header_value_empty":
		return invalidResponseHeader(index, code, map[string]interface{}{"name": name}, "header %q has no value", name)
	case "response_header_value_too_long":
		return invalidResponseHeader(index, code, map[string]interface{}{"name": name, "max": maxResponseHeaderValueLen}, "value of header %q is longer than %d bytes", name, maxResponseHeaderValueLen)
	default:
		return invalidResponseHeader(index, code, map[string]interface{}{"name": name}, "value of header %q contains line breaks or control characters", name)
	}
}

// responseHeaderNameCode returns the error code for an unusable header name, else "".
func responseHeaderNameCode(name string) string {
	switch {
	case name == "":
		return "response_header_name_empty"
	case len(name) > maxResponseHeaderNameLen:
		return "response_header_name_too_long"
	}
	for i := 0; i < len(name); i++ {
		if !isResponseHeaderTChar(name[i]) {
			return "response_header_name_invalid"
		}
	}
	lower := strings.ToLower(name)
	if forbiddenResponseHeaders[lower] || strings.HasPrefix(lower, forbiddenResponseHeaderPrefix) {
		return "response_header_name_forbidden"
	}
	return ""
}

// isResponseHeaderTChar reports whether c may appear in an RFC 7230 token.
func isResponseHeaderTChar(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0
}

// responseHeaderValueCode returns the error code for an unusable value template, else "".
func responseHeaderValueCode(value string) string {
	switch {
	case value == "":
		return "response_header_value_empty"
	case len(value) > maxResponseHeaderValueLen:
		return "response_header_value_too_long"
	case !utf8.ValidString(value):
		return "response_header_value_invalid"
	}
	for i := 0; i < len(value); i++ {
		if c := value[i]; (c < 0x20 && c != '\t') || c == 0x7f {
			return "response_header_value_invalid"
		}
	}
	return ""
}

// unknownResponseHeaderVariable returns the first {name} placeholder that is not a known
// variable, else "". Other braces are literal text. A name in another case, such as
// {Request_Id}, is refused too: it would be sent as written.
func unknownResponseHeaderVariable(value string) string {
	for rest := value; ; {
		open := strings.IndexByte(rest, '{')
		if open < 0 {
			return ""
		}
		rest = rest[open+1:]
		end := strings.IndexByte(rest, '}')
		if end < 0 {
			return ""
		}
		name := rest[:end]
		if isPlaceholderName(name) && !isResponseHeaderVariable(name) {
			return name
		}
	}
}

func isPlaceholderName(name string) bool {
	isLetter := func(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }
	if name == "" || !isLetter(name[0]) {
		return false
	}
	for i := 1; i < len(name); i++ {
		if c := name[i]; !isLetter(c) && c != '_' && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

func isResponseHeaderVariable(name string) bool {
	for _, known := range ResponseHeaderVariables {
		if known == name {
			return true
		}
	}
	return false
}
