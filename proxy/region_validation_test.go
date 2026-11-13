package proxy

import (
	"encoding/json"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

const unsafeTestRegion = "@evil.example/x#"

func newRegionTestAdmin(t *testing.T) *Handler {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	config.SetPassword("admin-password")
	return newHandlerWithoutBackgroundForTest(t)
}

func serveRegionTestAdmin(h *Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Admin-Password", "admin-password")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func regionTestResponseError(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return resp.Error
}

func TestAdminRejectsUnsafeRegionAtEveryEntryPoint(t *testing.T) {
	h := newRegionTestAdmin(t)

	var outbound int32
	oldClient := auth.SetGlobalAuthClientForTest(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		atomic.AddInt32(&outbound, 1)
		return jsonResponse(http.StatusOK, `{}`), nil
	})})
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(oldClient) })

	cases := []struct{ path, body string }{
		{"/admin/api/auth/credentials", `{"refreshToken":"rt","clientId":"c","clientSecret":"s","authMethod":"idc","region":"` + unsafeTestRegion + `"}`},
		{"/admin/api/auth/credentials", `{"refreshToken":"rt","authMethod":"social","region":"` + unsafeTestRegion + `"}`},
		{"/admin/api/accounts", `{"email":"x@example.com","refreshToken":"rt","clientId":"c","clientSecret":"s","authMethod":"idc","region":"` + unsafeTestRegion + `"}`},
		{"/admin/api/auth/builderid/start", `{"region":"` + unsafeTestRegion + `"}`},
		{"/admin/api/auth/iam-sso/start", `{"startUrl":"https://view.awsapps.com/start","region":"` + unsafeTestRegion + `"}`},
		{"/admin/api/auth/sso-token", `{"bearerToken":"token","region":"` + unsafeTestRegion + `"}`},
	}
	for _, tc := range cases {
		rec := serveRegionTestAdmin(h, http.MethodPost, tc.path, tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d body=%s, want 400", tc.path, rec.Code, rec.Body.String())
			continue
		}
		if got := regionTestResponseError(t, rec); got != config.ErrInvalidRegion.Error() {
			t.Errorf("%s: error = %q, want %q", tc.path, got, config.ErrInvalidRegion.Error())
		}
	}
	if got := atomic.LoadInt32(&outbound); got != 0 {
		t.Fatalf("an unsafe region must never reach the network, got %d requests", got)
	}
	if n := len(config.GetAccounts()); n != 0 {
		t.Fatalf("no account may be stored with an unsafe region, got %d", n)
	}
}

func TestAdminRejectsNewAPIKeyAccountOutsideKiroRegions(t *testing.T) {
	h := newRegionTestAdmin(t)
	stubImportNetwork(t)

	for _, tc := range []struct{ path, body string }{
		{"/admin/api/auth/credentials", `{"kiroApiKey":"ksk_sydney","authMethod":"api_key","region":"ap-southeast-2"}`},
		{"/admin/api/auth/credentials", `{"kiroApiKey":"ksk_sydney|ap-southeast-2","authMethod":"api_key"}`},
		{"/admin/api/accounts", `{"kiroApiKey":"ksk_sydney","authMethod":"api_key","region":"ap-southeast-2","enabled":true}`},
	} {
		rec := serveRegionTestAdmin(h, http.MethodPost, tc.path, tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s %s: status = %d body=%s, want 400", tc.path, tc.body, rec.Code, rec.Body.String())
			continue
		}
		if got := regionTestResponseError(t, rec); got != config.ErrUnsupportedKiroAPIKeyRegion.Error() {
			t.Errorf("%s: error = %q, want %q", tc.path, got, config.ErrUnsupportedKiroAPIKeyRegion.Error())
		}
	}
	if n := len(config.GetAccounts()); n != 0 {
		t.Fatalf("no API key account may be stored in an unserved region, got %d", n)
	}
}

func TestAdminUILocalizesRegionErrors(t *testing.T) {
	const path = "../ui/src/lib/api/server-errors.ts"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read server-errors.ts: %v", err)
	}
	src := string(data)
	//! SERVER_ERROR_KEYS matches server messages verbatim, so a reworded error would silently lose its translation.
	for _, msg := range []string{config.ErrInvalidRegion.Error(), config.ErrUnsupportedKiroAPIKeyRegion.Error()} {
		if !strings.Contains(src, "'"+msg+"'") && !strings.Contains(src, `"`+msg+`"`) {
			t.Errorf("%s SERVER_ERROR_KEYS has no entry for %q", path, msg)
		}
	}
}
