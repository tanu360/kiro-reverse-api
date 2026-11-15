package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/tunnel"
)

func setupTunnelTest(t *testing.T) *Handler {
	t.Helper()
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	config.SetPassword("admin-password")
	return newHandlerWithoutBackgroundForTest(t)
}

func decodeTunnel(t *testing.T, rec *httptest.ResponseRecorder) tunnelResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got tunnelResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestTunnelSettingsStartOffWithTheDefaultName(t *testing.T) {
	h := setupTunnelTest(t)
	got := decodeTunnel(t, adminRequest(t, h, http.MethodGet, "/tunnel", ""))
	if got.Enabled || got.State != tunnel.StateOff || got.Hostname != "kiro-proxy" || got.DefaultHostname != "kiro-proxy" {
		t.Fatalf("got %+v", got)
	}
	if got.TwoFactor || got.APIKeys {
		t.Errorf("warnings = twoFactor %v apiKeys %v, want both false on a new install", got.TwoFactor, got.APIKeys)
	}
}

func TestTunnelSettingsSaveTheSwitchAndName(t *testing.T) {
	h := setupTunnelTest(t)
	got := decodeTunnel(t, adminRequest(t, h, http.MethodPost, "/tunnel", `{"enabled":true,"hostname":"my-box"}`))
	if !got.Enabled || got.Hostname != "my-box" {
		t.Fatalf("got %+v", got)
	}
	if s := config.GetTunnelSettings(); !s.Enabled || s.Hostname != "my-box" {
		t.Fatalf("saved %+v", s)
	}
	// A partial update keeps the other field.
	got = decodeTunnel(t, adminRequest(t, h, http.MethodPost, "/tunnel", `{"enabled":false}`))
	if got.Enabled || got.Hostname != "my-box" {
		t.Fatalf("after switching off: %+v", got)
	}
}

func TestTunnelSettingsRefuseABadDeviceName(t *testing.T) {
	h := setupTunnelTest(t)
	for _, name := range []string{"", "My-Box", "-box", "box-", "a.b", "has space", "x23456789012345678901234567890123456789012345678901234567890abcd"} {
		body, _ := json.Marshal(map[string]string{"hostname": name})
		rec := adminRequest(t, h, http.MethodPost, "/tunnel", string(body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("hostname %q: status %d, want 400", name, rec.Code)
			continue
		}
		var e struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&e)
		if e.Code != codeTunnelHostname {
			t.Errorf("hostname %q: code %q", name, e.Code)
		}
	}
	if s := config.GetTunnelSettings(); s.Hostname != "kiro-proxy" {
		t.Errorf("a refused name was saved: %+v", s)
	}
}

// linkAdminRequest is adminRequest as if it came in through the public link.
func linkAdminRequest(t *testing.T, h *Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/admin/api"+path, strings.NewReader(body))
	req.Header.Set("X-Admin-Password", "admin-password")
	req = req.WithContext(tunnel.WithTunnel(req.Context()))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTunnelSaysWhetherThePageCameThroughTheLink(t *testing.T) {
	h := setupTunnelTest(t)
	if got := decodeTunnel(t, adminRequest(t, h, http.MethodGet, "/tunnel", "")); got.ViaLink {
		t.Error("a local request reads as through the link")
	}
	if got := decodeTunnel(t, linkAdminRequest(t, h, http.MethodGet, "/tunnel", "")); !got.ViaLink {
		t.Error("a request through the link reads as local")
	}
}

func TestTheDeviceNameCannotChangeThroughTheLink(t *testing.T) {
	h := setupTunnelTest(t)
	if err := config.UpdateTunnelSettings(config.TunnelSettings{Enabled: true, Hostname: "kiro-proxy"}); err != nil {
		t.Fatal(err)
	}
	rec := linkAdminRequest(t, h, http.MethodPost, "/tunnel", `{"hostname":"kiro"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403: %s", rec.Code, rec.Body.String())
	}
	var e struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&e)
	if e.Code != codeTunnelRenameRemote {
		t.Errorf("code %q", e.Code)
	}
	if s := config.GetTunnelSettings(); s.Hostname != "kiro-proxy" {
		t.Errorf("the name changed through the link: %+v", s)
	}
	// The same name is no change, and a local request renames.
	decodeTunnel(t, linkAdminRequest(t, h, http.MethodPost, "/tunnel", `{"hostname":"kiro-proxy"}`))
	if got := decodeTunnel(t, adminRequest(t, h, http.MethodPost, "/tunnel", `{"hostname":"kiro"}`)); got.Hostname != "kiro" {
		t.Errorf("local rename: %+v", got)
	}
}

func TestTurningTheLinkOffThroughItAnswersAsOff(t *testing.T) {
	h := setupTunnelTest(t)
	if err := config.UpdateTunnelSettings(config.TunnelSettings{Enabled: true, Hostname: "kiro-proxy"}); err != nil {
		t.Fatal(err)
	}
	got := decodeTunnel(t, linkAdminRequest(t, h, http.MethodPost, "/tunnel", `{"enabled":false}`))
	if got.Enabled || got.State != tunnel.StateOff || !got.ViaLink {
		t.Fatalf("got %+v", got)
	}
	if s := config.GetTunnelSettings(); s.Enabled {
		t.Fatalf("saved %+v", s)
	}
}

func TestTunnelAPINeedsAdmin(t *testing.T) {
	h := setupTunnelTest(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/api/tunnel", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}

func TestTunnelLogoutTurnsTheSwitchOff(t *testing.T) {
	h := setupTunnelTest(t)
	if err := config.UpdateTunnelSettings(config.TunnelSettings{Enabled: true, Hostname: "box"}); err != nil {
		t.Fatal(err)
	}
	got := decodeTunnel(t, adminRequest(t, h, http.MethodPost, "/tunnel/logout", ""))
	if got.Enabled || got.SignedIn {
		t.Fatalf("got %+v", got)
	}
	if s := config.GetTunnelSettings(); s.Enabled || s.Hostname != "box" {
		t.Fatalf("saved %+v", s)
	}
}

func TestFirstRunPasswordHiddenOnThePublicLink(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	h := newHandlerWithoutBackgroundForTest(t)
	if firstRunPassword(t, h) == "" {
		t.Fatal("no first-run password locally")
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/api/first-run", nil)
	req = req.WithContext(tunnel.WithTunnel(req.Context()))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Password != "" {
		t.Fatalf("the public link showed the first-run password %q", body.Password)
	}
}

func TestPublicLinkCallsNeedAnAPIKey(t *testing.T) {
	h := setupTunnelTest(t)
	off := false
	if err := config.UpdateSettingsPatch(&off, ""); err != nil {
		t.Fatal(err)
	}

	local := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	if _, err := h.authenticate(local); err != nil {
		t.Fatalf("a local call without a key was refused: %v", err)
	}

	public := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	public = public.WithContext(tunnel.WithTunnel(public.Context()))
	_, err := h.authenticate(public)
	ae, ok := err.(*authError)
	if !ok || ae.status != http.StatusUnauthorized {
		t.Fatalf("a public call without a key: err %v, want a 401", err)
	}
}

func TestTunnelProgressEventsAreSpaced(t *testing.T) {
	lastTunnelProgress.Store(0)
	id, ch := getBroadcaster().Subscribe()
	defer getBroadcaster().Unsubscribe(id)

	for _, pct := range []int{1, 2, 3, 100} {
		TunnelChanged(tunnel.Status{State: tunnel.StateDownloading, Progress: &pct})
	}
	TunnelChanged(tunnel.Status{State: tunnel.StateStarting})

	got := 0
	for {
		select {
		case evt := <-ch:
			if evt.Type == eventSettingsChanged && evt.Payload == "tunnel" {
				got++
			}
			continue
		case <-time.After(100 * time.Millisecond):
		}
		break
	}
	// 1 percent, 100 percent and the next state; 2 and 3 fall inside the gap.
	if got != 3 {
		t.Fatalf("events = %d, want 3", got)
	}
}
