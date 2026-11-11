package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"kiro-proxy/auth"
	"kiro-proxy/config"
)

func decodeAdminError(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func TestWriteAdminErrKeepsMessageAndAddsCode(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		fallback string
		want     map[string]interface{}
	}{
		{
			name: "token refresh keeps its prefix and reports the upstream reason",
			err:  &tokenRefreshError{prefix: "token refresh failed", err: errors.New("HTTP 400: invalid_grant")},
			want: map[string]interface{}{
				"error":  "token refresh failed: HTTP 400: invalid_grant",
				"code":   codeTokenRefreshFailed,
				"detail": "HTTP 400: invalid_grant",
			},
		},
		{
			name: "a sign-in error carries its placeholders",
			err: &auth.FlowError{
				Code:   auth.CodeCallbackURLWrongAddress,
				Text:   "callback URL must be http://localhost:3128/oauth/callback",
				Params: map[string]string{"expected": "http://localhost:3128/oauth/callback"},
			},
			want: map[string]interface{}{
				"error":    "callback URL must be http://localhost:3128/oauth/callback",
				"code":     auth.CodeCallbackURLWrongAddress,
				"expected": "http://localhost:3128/oauth/callback",
			},
		},
		{
			name: "a config sentinel maps to its code",
			err:  fmt.Errorf("save: %w", config.ErrApiKeyExists),
			want: map[string]interface{}{"error": "save: api key already exists", "code": codeAPIKeyExists},
		},
		{
			name: "a profile check keeps the code of the token refresh inside it",
			err:  &profileVerifyError{err: &tokenRefreshError{prefix: "Token refresh failed", err: errors.New("expired")}},
			want: map[string]interface{}{
				"error":  "Unable to verify profileArn against Kiro profiles: Token refresh failed: expired",
				"code":   codeTokenRefreshFailed,
				"detail": "expired",
			},
		},
		{
			name:     "an unknown error takes the fallback code with itself as the detail",
			err:      errors.New("HTTP 503: busy"),
			fallback: codeOverageFailed,
			want:     map[string]interface{}{"error": "HTTP 503: busy", "code": codeOverageFailed, "detail": "HTTP 503: busy"},
		},
		{
			name: "an unknown error without a fallback stays bare",
			err:  errors.New("disk full"),
			want: map[string]interface{}{"error": "disk full"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeAdminErr(rec, http.StatusBadRequest, tc.err, tc.fallback)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d", rec.Code)
			}
			body := decodeAdminError(t, rec)
			if len(body) != len(tc.want) {
				t.Fatalf("body = %v, want %v", body, tc.want)
			}
			for name, value := range tc.want {
				if body[name] != value {
					t.Fatalf("%s = %v, want %v (body %v)", name, body[name], value, body)
				}
			}
		})
	}
}

func TestBatchResultCarriesCode(t *testing.T) {
	var res accountResult
	res.fail(&tokenRefreshError{prefix: "token refresh failed", err: errors.New("invalid_grant")})
	if res.Error != "token refresh failed: invalid_grant" || res.Code != codeTokenRefreshFailed || res.Detail != "invalid_grant" {
		t.Fatalf("result = %+v", res)
	}

	var raw accountResult
	raw.fail(errors.New("HTTP 500"))
	if raw.Error != "HTTP 500" || raw.Code != "" || raw.Detail != "" {
		t.Fatalf("raw result = %+v", raw)
	}

	if missing := notFoundResult("gone"); missing.Code != codeAccountNotFound || missing.Error != "Account not found" {
		t.Fatalf("not found result = %+v", missing)
	}
}

func TestModelMappingErrorCarriesCodeAndModel(t *testing.T) {
	err := config.UpdateModelMappings([]config.ModelMappingRule{{Key: "gpt-5", Value: "a"}, {Key: "GPT-5", Value: "b"}})
	var mappingErr *config.ModelMappingError
	if !errors.As(err, &mappingErr) {
		t.Fatalf("err = %v, want a ModelMappingError", err)
	}
	body := adminErrorBody(err, "")
	if body["code"] != "model_mapping_duplicate" || body["model"] != "gpt-5" || body["error"] != `source "gpt-5" is mapped more than once` {
		t.Fatalf("body = %v", body)
	}
}
