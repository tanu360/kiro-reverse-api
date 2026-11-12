package config

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestResponseHeadersDefaultEmpty(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	got := GetResponseHeaders()
	if got == nil || len(got) != 0 {
		t.Fatalf("default list must be empty and non-nil, got %#v", got)
	}
	if active := ActiveResponseHeaders(); len(active) != 0 {
		t.Fatalf("no header may be active by default, got %#v", active)
	}
}

func TestUpdateResponseHeadersRejectsInvalidEntries(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	ok := ResponseHeaderRule{Name: "X-Request-Id", Value: "{request_id}", Enabled: true}
	tooMany := make([]ResponseHeaderRule, MaxResponseHeaders+1)
	for i := range tooMany {
		tooMany[i] = ResponseHeaderRule{Name: fmt.Sprintf("X-H-%d", i), Value: "v"}
	}
	cases := []struct {
		name      string
		rules     []ResponseHeaderRule
		wantIndex int
		wantCode  string
	}{
		{"too many", tooMany, -1, "response_headers_too_many"},
		{"empty name", []ResponseHeaderRule{ok, {Name: "  ", Value: "x"}}, 1, "response_header_name_empty"},
		{"space in name", []ResponseHeaderRule{{Name: "Bad Name", Value: "x"}}, 0, "response_header_name_invalid"},
		{"colon in name", []ResponseHeaderRule{{Name: "X-A:", Value: "x"}}, 0, "response_header_name_invalid"},
		{"newline in name", []ResponseHeaderRule{{Name: "X-A\nX-B", Value: "x"}}, 0, "response_header_name_invalid"},
		{"non-ascii name", []ResponseHeaderRule{{Name: "X-Ä", Value: "x"}}, 0, "response_header_name_invalid"},
		{"long name", []ResponseHeaderRule{{Name: strings.Repeat("a", maxResponseHeaderNameLen+1), Value: "x"}}, 0, "response_header_name_too_long"},
		{"connection", []ResponseHeaderRule{{Name: "Connection", Value: "close"}}, 0, "response_header_name_forbidden"},
		{"content-length", []ResponseHeaderRule{{Name: "content-length", Value: "1"}}, 0, "response_header_name_forbidden"},
		{"transfer-encoding", []ResponseHeaderRule{{Name: "Transfer-Encoding", Value: "chunked"}}, 0, "response_header_name_forbidden"},
		{"content-type", []ResponseHeaderRule{{Name: "Content-Type", Value: "text/plain"}}, 0, "response_header_name_forbidden"},
		{"set-cookie", []ResponseHeaderRule{{Name: "Set-Cookie", Value: "a=b"}}, 0, "response_header_name_forbidden"},
		{"cors", []ResponseHeaderRule{{Name: "Access-Control-Allow-Origin", Value: "*"}}, 0, "response_header_name_forbidden"},
		{"cors expose", []ResponseHeaderRule{{Name: "ACCESS-CONTROL-EXPOSE-HEADERS", Value: "x"}}, 0, "response_header_name_forbidden"},
		{"duplicate", []ResponseHeaderRule{ok, {Name: "x-request-id", Value: "y"}}, 1, "response_header_name_duplicate"},
		{"empty value", []ResponseHeaderRule{{Name: "X-A", Value: " \t"}}, 0, "response_header_value_empty"},
		{"crlf value", []ResponseHeaderRule{{Name: "X-A", Value: "a\r\nX-Evil: 1"}}, 0, "response_header_value_invalid"},
		{"trailing lf", []ResponseHeaderRule{{Name: "X-A", Value: "a\n"}}, 0, "response_header_value_invalid"},
		{"nul value", []ResponseHeaderRule{{Name: "X-A", Value: "a\x00b"}}, 0, "response_header_value_invalid"},
		{"del value", []ResponseHeaderRule{{Name: "X-A", Value: "a\x7fb"}}, 0, "response_header_value_invalid"},
		{"invalid utf8", []ResponseHeaderRule{{Name: "X-A", Value: "a\xffb"}}, 0, "response_header_value_invalid"},
		{"long value", []ResponseHeaderRule{{Name: "X-A", Value: strings.Repeat("v", maxResponseHeaderValueLen+1)}}, 0, "response_header_value_too_long"},
		{"unknown variable", []ResponseHeaderRule{ok, {Name: "X-A", Value: "id={reqid}"}}, 1, "response_header_unknown_variable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := GetResponseHeaders()
			err := UpdateResponseHeaders(tc.rules)
			if !errors.Is(err, ErrInvalidResponseHeader) {
				t.Fatalf("expected ErrInvalidResponseHeader, got %v", err)
			}
			var headerErr *ResponseHeaderError
			if !errors.As(err, &headerErr) || headerErr.Index != tc.wantIndex || headerErr.Code != tc.wantCode {
				t.Fatalf("want index %d code %s, got %#v", tc.wantIndex, tc.wantCode, err)
			}
			if got := GetResponseHeaders(); len(got) != len(before) {
				t.Fatalf("a rejected save must not change the list: before=%d after=%d", len(before), len(got))
			}
		})
	}

	err := UpdateResponseHeaders([]ResponseHeaderRule{{Name: "X-A", Value: "{reqid}"}})
	var headerErr *ResponseHeaderError
	if !errors.As(err, &headerErr) || headerErr.Params["variable"] != "reqid" {
		t.Fatalf("unknown variable must name it, got %#v", err)
	}
}

func TestUpdateResponseHeadersTrimsAndPersists(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	full := make([]ResponseHeaderRule, MaxResponseHeaders)
	for i := range full {
		full[i] = ResponseHeaderRule{Name: fmt.Sprintf("X-H-%d", i), Value: "v"}
	}
	if err := UpdateResponseHeaders(full); err != nil {
		t.Fatalf("%d headers must be allowed: %v", MaxResponseHeaders, err)
	}

	rules := []ResponseHeaderRule{
		{Name: " X-Request-Id\t", Value: "  {request_id} ", Enabled: true},
		{Name: "X-Kiro-Trace", Value: "{model}/{account_id}/{key_id}/{client_ip} {Literal} {0} {", Enabled: false},
		{Name: "x~custom!#$%&'*+-.^_`|", Value: "ok", Enabled: true},
	}
	if err := UpdateResponseHeaders(rules); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	got := GetResponseHeaders()
	if len(got) != 3 || got[0] != (ResponseHeaderRule{Name: "X-Request-Id", Value: "{request_id}", Enabled: true}) {
		t.Fatalf("expected trimmed, persisted rules, got %#v", got)
	}
	if got[1].Enabled || got[1].Value != rules[1].Value {
		t.Fatalf("disabled rule must persist as written, got %#v", got[1])
	}
	active := ActiveResponseHeaders()
	if len(active) != 2 || active[0].Name != "X-Request-Id" || active[1].Name != rules[2].Name {
		t.Fatalf("only enabled rules are active, got %#v", active)
	}

	// The copy is the caller's: changing it leaves the config alone.
	got[0].Value = "changed"
	if GetResponseHeaders()[0].Value != "{request_id}" {
		t.Fatalf("GetResponseHeaders must return a copy")
	}

	if err := UpdateResponseHeaders(nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got := GetResponseHeaders(); len(got) != 0 {
		t.Fatalf("expected an empty list after clearing, got %#v", got)
	}
}

func TestActiveResponseHeadersSkipsUnsafeStoredRules(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	//! A hand-edited or restored config bypasses UpdateResponseHeaders.
	cfgLock.Lock()
	cfg.ResponseHeaders = []ResponseHeaderRule{
		{Name: "Content-Length", Value: "0", Enabled: true},
		{Name: "X-Ok", Value: "fine", Enabled: true},
		{Name: "X-Bad", Value: "a\r\nb", Enabled: true},
		{Name: "Bad Name", Value: "x", Enabled: true},
	}
	cfgLock.Unlock()
	active := ActiveResponseHeaders()
	if len(active) != 1 || active[0].Name != "X-Ok" {
		t.Fatalf("expected only the safe rule, got %#v", active)
	}
}
