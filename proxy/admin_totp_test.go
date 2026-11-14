package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/totp"
)

func serveAdminJSON(h *Handler, method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "192.0.2.10:5555"
	if token != "" {
		req.Header.Set("X-Admin-Token", token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeTOTPJSON(t *testing.T, rec *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), into); err != nil {
		t.Fatalf("decode %d %q: %v", rec.Code, rec.Body.String(), err)
	}
}

func signInPassword(t *testing.T, h *Handler) string {
	t.Helper()
	rec := serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password"}`)
	var resp struct {
		Token string `json:"token"`
	}
	decodeTOTPJSON(t, rec, &resp)
	if resp.Token == "" {
		t.Fatalf("sign-in: %d %s", rec.Code, rec.Body.String())
	}
	return resp.Token
}

// codeFor is the code of secret for now plus offset steps.
func codeFor(t *testing.T, secret string, offset int64) string {
	t.Helper()
	code, err := totp.CodeAt(secret, totp.Step(time.Now())+offset)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

// enableTOTP turns two-factor sign-in on and returns the secret, the session and the recovery codes.
func enableTOTP(t *testing.T, h *Handler) (string, string, []string) {
	t.Helper()
	token := signInPassword(t, h)
	rec := serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/setup", token, "")
	var setup struct {
		Secret     string `json:"secret"`
		OtpauthURL string `json:"otpauthUrl"`
		QRSvg      string `json:"qrSvg"`
	}
	decodeTOTPJSON(t, rec, &setup)
	if setup.Secret == "" || !strings.HasPrefix(setup.OtpauthURL, "otpauth://totp/") || !strings.HasPrefix(setup.QRSvg, "<svg") {
		t.Fatalf("setup: %d %s", rec.Code, rec.Body.String())
	}
	if config.AdminTOTPEnabled() {
		t.Fatal("setup alone turned two-factor sign-in on")
	}
	rec = serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/enable", token, `{"code":"000000"}`)
	if rec.Code != http.StatusBadRequest || config.AdminTOTPEnabled() {
		t.Fatalf("a wrong confirming code: %d %s", rec.Code, rec.Body.String())
	}
	rec = serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/enable", token, `{"code":"`+codeFor(t, setup.Secret, 0)+`"}`)
	var enabled struct {
		RecoveryCodes []string               `json:"recoveryCodes"`
		Status        config.AdminTOTPStatus `json:"status"`
	}
	decodeTOTPJSON(t, rec, &enabled)
	if len(enabled.RecoveryCodes) != recoveryCodeCount || !enabled.Status.Enabled || enabled.Status.RecoveryCodes != recoveryCodeCount {
		t.Fatalf("enable: %d %s", rec.Code, rec.Body.String())
	}
	return setup.Secret, token, enabled.RecoveryCodes
}

type sessionAnswer struct {
	Token             string `json:"token"`
	TwoFactorRequired bool   `json:"twoFactorRequired"`
	Challenge         string `json:"challenge"`
	Code              string `json:"code"`
}

func TestTwoFactorSignInFlow(t *testing.T) {
	h := newRegionTestAdmin(t)
	secret, token, recovery := enableTOTP(t, h)

	// The session that turned it on stays; the secret never shows in the status.
	rec := serveAdminJSON(h, http.MethodGet, "/admin/api/two-factor", token, "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("status: %d %s", rec.Code, rec.Body.String())
	}
	if raw := serveAdminJSON(h, http.MethodGet, "/admin/api/settings", token, "").Body.String(); strings.Contains(raw, secret) {
		t.Fatal("settings leak the two-factor secret")
	}

	// The password alone now answers a challenge, not a token.
	var first sessionAnswer
	decodeTOTPJSON(t, serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password"}`), &first)
	if first.Token != "" || !first.TwoFactorRequired || first.Challenge == "" {
		t.Fatalf("password step: %+v", first)
	}
	// A wrong code fails; the next code (one step of skew) passes once.
	var wrong sessionAnswer
	rec = serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"challenge":"`+first.Challenge+`","code":"123456"}`)
	decodeTOTPJSON(t, rec, &wrong)
	if rec.Code != http.StatusUnauthorized || wrong.Code != codeTOTPInvalid {
		t.Fatalf("wrong code: %d %s", rec.Code, rec.Body.String())
	}
	code := codeFor(t, secret, 1)
	var ok sessionAnswer
	decodeTOTPJSON(t, serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"challenge":"`+first.Challenge+`","code":"`+code+`"}`), &ok)
	if ok.Token == "" {
		t.Fatalf("right code: %+v", ok)
	}
	// The challenge is used up, and the same code is refused on a new sign-in.
	rec = serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"challenge":"`+first.Challenge+`","code":"`+code+`"}`)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), codeTOTPChallengeExpired) {
		t.Fatalf("reused challenge: %d %s", rec.Code, rec.Body.String())
	}
	var reused sessionAnswer
	rec = serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password","code":"`+code+`"}`)
	decodeTOTPJSON(t, rec, &reused)
	if rec.Code != http.StatusUnauthorized || reused.Code != codeTOTPReused {
		t.Fatalf("reused code: %d %s", rec.Code, rec.Body.String())
	}
	// An older code than the last one accepted is refused too.
	rec = serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password","code":"`+codeFor(t, secret, 0)+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("an older code: %d %s", rec.Code, rec.Body.String())
	}

	// A recovery code works once, in any case and with or without its dash.
	var viaRecovery sessionAnswer
	decodeTOTPJSON(t, serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password","recoveryCode":"`+strings.ToUpper(strings.ReplaceAll(recovery[0], "-", ""))+`"}`), &viaRecovery)
	if viaRecovery.Token == "" {
		t.Fatalf("recovery code: %+v", viaRecovery)
	}
	rec = serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password","recoveryCode":"`+recovery[0]+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a used recovery code: %d %s", rec.Code, rec.Body.String())
	}
	if left := config.GetAdminTOTPStatus().RecoveryCodes; left != recoveryCodeCount-1 {
		t.Fatalf("recovery codes left %d", left)
	}

	// The password header no longer reaches the admin API on its own.
	req := httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil)
	req.Header.Set("X-Admin-Password", "admin-password")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), codeTOTPRequired) {
		t.Fatalf("password header with two-factor on: %d %s", rec.Code, rec.Body.String())
	}
}

func TestTwoFactorEnablingEndsOtherSessions(t *testing.T) {
	h := newRegionTestAdmin(t)
	other := signInPassword(t, h)
	_, token, _ := enableTOTP(t, h)
	if rec := serveAdminJSON(h, http.MethodGet, "/admin/api/two-factor", other, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a session from before two-factor sign-in still works: %d", rec.Code)
	}
	if rec := serveAdminJSON(h, http.MethodGet, "/admin/api/two-factor", token, ""); rec.Code != http.StatusOK {
		t.Fatalf("the session that turned it on was ended: %d", rec.Code)
	}
}

func TestTwoFactorCodeGuessesAreLimited(t *testing.T) {
	h := newRegionTestAdmin(t)
	enableTOTP(t, h)
	var first sessionAnswer
	decodeTOTPJSON(t, serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password"}`), &first)
	limited := false
	for i := 0; i < adminGuessesPerClient+2; i++ {
		rec := serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"challenge":"`+first.Challenge+`","code":"000000"}`)
		if rec.Code == http.StatusTooManyRequests {
			limited = rec.Header().Get("Retry-After") != ""
			break
		}
	}
	if !limited {
		t.Fatal("wrong codes were never rate-limited")
	}
}

func TestTwoFactorChallengeAllowsFewTries(t *testing.T) {
	h := newRegionTestAdmin(t)
	secret, _, _ := enableTOTP(t, h)
	var first sessionAnswer
	decodeTOTPJSON(t, serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"password":"admin-password"}`), &first)
	for i := 0; i < totpChallengeTries; i++ {
		h.totpState().challengeFailed(first.Challenge)
	}
	rec := serveAdminJSON(h, http.MethodPost, "/admin/api/session", "", `{"challenge":"`+first.Challenge+`","code":"`+codeFor(t, secret, 0)+`"}`)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), codeTOTPChallengeExpired) {
		t.Fatalf("a challenge past its tries: %d %s", rec.Code, rec.Body.String())
	}
}

func TestTwoFactorDisableNeedsCodeOrPassword(t *testing.T) {
	h := newRegionTestAdmin(t)
	secret, token, _ := enableTOTP(t, h)
	if rec := serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/disable", token, `{}`); rec.Code != http.StatusBadRequest || !config.AdminTOTPEnabled() {
		t.Fatalf("disable without proof: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/disable", token, `{"password":"wrong-password"}`); rec.Code != http.StatusUnauthorized || !config.AdminTOTPEnabled() {
		t.Fatalf("disable with a wrong password: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/disable", token, `{"code":"`+codeFor(t, secret, 1)+`"}`); rec.Code != http.StatusOK || config.AdminTOTPEnabled() {
		t.Fatalf("disable with a code: %d %s", rec.Code, rec.Body.String())
	}

	_, token, _ = enableTOTP(t, h)
	if rec := serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/disable", token, `{"password":"admin-password"}`); rec.Code != http.StatusOK || config.AdminTOTPEnabled() {
		t.Fatalf("disable with the password: %d %s", rec.Code, rec.Body.String())
	}
	// Off again: the password alone signs in.
	signInPassword(t, h)
}

func TestTwoFactorRecoveryCodesReplace(t *testing.T) {
	h := newRegionTestAdmin(t)
	secret, token, old := enableTOTP(t, h)
	rec := serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/recovery-codes", token, `{"code":"`+codeFor(t, secret, 1)+`"}`)
	var fresh struct {
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	decodeTOTPJSON(t, rec, &fresh)
	if len(fresh.RecoveryCodes) != recoveryCodeCount || fresh.RecoveryCodes[0] == old[0] {
		t.Fatalf("replace: %d %s", rec.Code, rec.Body.String())
	}
	if ok, _ := config.ConsumeAdminTOTPRecovery(old[1]); ok {
		t.Fatal("an old recovery code still works")
	}
}

func TestTwoFactorResetByEnvAtStart(t *testing.T) {
	h := newRegionTestAdmin(t)
	enableTOTP(t, h)
	path := db.Path()
	t.Setenv(config.ResetAdminTOTPEnv, "1")
	if err := config.Init(path); err != nil {
		t.Fatal(err)
	}
	if config.AdminTOTPEnabled() || !config.GetAdminTOTPStatus().ResetByEnv {
		t.Fatalf("status after the reset %+v", config.GetAdminTOTPStatus())
	}
	config.SetPassword("admin-password")
	token := signInPassword(t, h)
	// While the variable is set, setting it up again is refused.
	if rec := serveAdminJSON(h, http.MethodPost, "/admin/api/two-factor/setup", token, ""); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), codeTOTPResetByEnv) {
		t.Fatalf("setup with the reset set: %d %s", rec.Code, rec.Body.String())
	}
}

func TestFirstRunPasswordStillSignsIn(t *testing.T) {
	h := newRegionTestAdmin(t)
	if rec := serveAdminJSON(h, http.MethodGet, "/admin/api/first-run", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("first-run: %d", rec.Code)
	}
	signInPassword(t, h)
}
