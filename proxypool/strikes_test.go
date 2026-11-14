package proxypool

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"kiro-proxy/config"
)

func refused(id string) error {
	return &ProxyError{ProxyID: id, Kind: KindConnect, cause: errors.New("refused")}
}

func TestThreeFailedConnectionsDisableAProxy(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"), poolProxy("px_b", "http://10.0.0.2:3128"))
	acc := addAccount(t, "a1", "")
	if r := m.Resolve(acc); r.ProxyID != "px_a" {
		t.Fatalf("first pick %s", r.ProxyID)
	}
	for i := 1; i < MaxFailures; i++ {
		m.ReportFailure("px_a", refused("px_a"))
		h := m.Health("px_a")
		if h.Status == StatusFailed || h.Failures != i {
			t.Fatalf("after %d failures: %+v, want still in rotation with %d strikes", i, h, i)
		}
		if r := m.Resolve(acc); r.ProxyID != "px_a" {
			t.Fatalf("after %d failures the account moved to %s", i, r.ProxyID)
		}
	}
	if got := m.View().Proxies[0].State; got != StateUnhealthy {
		t.Fatalf("a failing proxy shows as %q, want %q", got, StateUnhealthy)
	}
	m.ReportFailure("px_a", refused("px_a"))
	if h := m.Health("px_a"); h.Status != StatusFailed || h.Failures != MaxFailures || h.FailedAt == 0 {
		t.Fatalf("after %d failures: %+v, want failed", MaxFailures, h)
	}
	if r := m.Resolve(acc); r.ProxyID != "px_b" {
		t.Fatalf("the account stayed on the disabled proxy: %s", r.ProxyID)
	}
	view := m.View()
	if view.Proxies[0].State != StateAutoDisabled || view.Counts.AutoDisabled != 1 || view.MaxFailures != MaxFailures {
		t.Fatalf("view %+v", view)
	}
}

func TestASuccessResetsTheStrikes(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	for i := 0; i < MaxFailures-1; i++ {
		m.ReportFailure("px_a", refused("px_a"))
	}
	m.ReportSuccess("px_a")
	if h := m.Health("px_a"); h.Status != StatusOK || h.Failures != 0 || h.LastError != "" {
		t.Fatalf("after a success: %+v", h)
	}
	// The count starts over: two more failures still leave it in rotation.
	for i := 0; i < MaxFailures-1; i++ {
		m.ReportFailure("px_a", refused("px_a"))
	}
	if h := m.Health("px_a"); h.Status == StatusFailed {
		t.Fatalf("strikes from before the success still counted: %+v", h)
	}
}

func TestFailedChecksDisableAndAPassingCheckRecovers(t *testing.T) {
	dead := poolProxy("px_dead", closedPortURL(t))
	m := setupPool(t, dead)
	for i := 1; i <= MaxFailures; i++ {
		h, err := m.CheckOne(context.Background(), dead.ID)
		if err != nil {
			t.Fatal(err)
		}
		if h.Failures != i || (i < MaxFailures) == (h.Status == StatusFailed) {
			t.Fatalf("after check %d: %+v", i, h)
		}
	}
	// The proxy comes back: point it at a working one and check again.
	live := fakeProxy(t, http.StatusForbidden)
	cfgPool := config.GetProxyPool()
	cfgPool[0].URL = live
	if err := config.SetProxyPool(cfgPool); err != nil {
		t.Fatal(err)
	}
	h, err := m.CheckOne(context.Background(), dead.ID)
	if err != nil {
		t.Fatal(err)
	}
	if h.Status != StatusOK || h.Failures != 0 {
		t.Fatalf("a passing check left %+v, want healthy", h)
	}
	if m.View().Proxies[0].State != StateHealthy {
		t.Fatalf("state %q after recovery", m.View().Proxies[0].State)
	}
}

func TestDetourMovesOnlyTheFailingAccount(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"), poolProxy("px_b", "http://10.0.0.2:3128"))
	a1, a2, a3 := addAccount(t, "a1", ""), addAccount(t, "a2", ""), addAccount(t, "a3", "")
	m.Resolve(a1) // px_a
	m.Resolve(a2) // px_b
	m.Resolve(a3) // px_a
	m.ReportFailure("px_a", refused("px_a"))
	if !m.Detour("a1", "px_a") {
		t.Fatal("the failing account did not move")
	}
	if r := m.Resolve(a1); r.ProxyID != "px_b" {
		t.Fatalf("a1 retried on %s, want px_b", r.ProxyID)
	}
	if r := m.Resolve(a3); r.ProxyID != "px_a" {
		t.Fatalf("a3 moved with a1: %s", r.ProxyID)
	}
	if h := m.Health("px_a"); h.Status == StatusFailed || h.Failures != 1 {
		t.Fatalf("one blip condemned the proxy: %+v", h)
	}
	if m.Detour("a2", "px_a") {
		t.Fatal("an account on another proxy was moved")
	}
}

func TestDetourStaysWithoutAnotherProxy(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	acc := addAccount(t, "a1", "")
	m.Resolve(acc)
	m.ReportFailure("px_a", refused("px_a"))
	if m.Detour("a1", "px_a") {
		t.Fatal("moved with no other proxy to go to")
	}
	if r := m.Resolve(acc); r.ProxyID != "px_a" || r.Unavailable {
		t.Fatalf("one failure took the only proxy out: %+v", r)
	}
}

func TestSwitchedOffProxyIsNeverUsedOrRecovered(t *testing.T) {
	live := poolProxy("px_live", fakeProxy(t, http.StatusForbidden))
	m := setupPool(t, live, poolProxy("px_b", "http://10.0.0.2:3128"))
	acc := addAccount(t, "a1", "")
	if r := m.Resolve(acc); r.ProxyID != "px_live" {
		t.Fatalf("first pick %s", r.ProxyID)
	}
	off := false
	p, err := m.Update("px_live", ProxyInput{Enabled: &off})
	if err != nil || !p.Disabled {
		t.Fatalf("switch off: %+v %v", p, err)
	}
	if r := m.Resolve(acc); r.ProxyID != "px_b" {
		t.Fatalf("the account stayed on a proxy switched off: %s", r.ProxyID)
	}
	for i := 0; i < 3; i++ {
		if r := m.Resolve(addAccount(t, "n"+string(rune('0'+i)), "")); r.ProxyID == "px_live" {
			t.Fatal("a new account got the proxy switched off")
		}
	}
	// A check-all passes over it, and a passing check on demand does not switch it on.
	<-m.StartCheckAll()
	if h := m.Health("px_live"); h.CheckedAt != 0 {
		t.Fatalf("check-all checked a proxy switched off: %+v", h)
	}
	if _, err := m.CheckOne(context.Background(), "px_live"); err != nil {
		t.Fatal(err)
	}
	if pv := m.View().Proxies[0]; pv.Enabled || pv.State != StateOff {
		t.Fatalf("a passing check switched it back on: %+v", pv)
	}
	if view := m.View(); view.Counts.Off != 1 {
		t.Fatalf("counts %+v", view.Counts)
	}
	on := true
	if _, err := m.Update("px_live", ProxyInput{Enabled: &on}); err != nil {
		t.Fatal(err)
	}
	if pv := m.View().Proxies[0]; !pv.Enabled || pv.State == StateOff {
		t.Fatalf("switched on: %+v", pv)
	}
}

func TestSwitchedOffAloneMakesThePoolUnavailable(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	m.mu.Lock()
	m.lastKick = m.now() // no background check-all from this test
	m.mu.Unlock()
	off := false
	if _, err := m.Update("px_a", ProxyInput{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if r := m.Resolve(addAccount(t, "a1", "")); !r.Unavailable {
		t.Fatalf("the only proxy is off, want unavailable: %+v", r)
	}
}

func TestSavedFailedProxyStaysOutUntilACheckPasses(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	if err := config.SaveProxyPoolState(`{"health":{"px_a":{"status":"failed","lastError":"connection refused or reset"}}}`); err != nil {
		t.Fatal(err)
	}
	m.ResetForTest()
	if h := m.Health("px_a"); h.Status != StatusFailed || h.Failures != MaxFailures {
		t.Fatalf("an old failed proxy loaded as %+v", h)
	}
}

func TestDetectedProxiesListGlobalAndAccountProxies(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	if err := config.UpdateProxySettings("http://10.0.0.1:3128"); err != nil {
		t.Fatal(err)
	}
	addAccount(t, "own1", "socks5://alice:hunter2-secret@own.example:1080")
	addAccount(t, "own2", "socks5://alice:hunter2-secret@own.example:1080")
	addAccount(t, "plain", "http://open.example:8080")
	view := m.View()
	if len(view.Detected) != 3 {
		t.Fatalf("detected %+v", view.Detected)
	}
	global := view.Detected[0]
	if !global.Global || !global.InPool || global.CanAdopt || global.URL != "http://10.0.0.1:3128" {
		t.Fatalf("global entry %+v", global)
	}
	var signed, open DetectedView
	for _, d := range view.Detected[1:] {
		if d.Username != "" {
			signed = d
		} else {
			open = d
		}
	}
	if signed.URL != "socks5://own.example:1080" || !signed.HasPassword || signed.CanAdopt || len(signed.AccountIDs) != 2 {
		t.Fatalf("signed-in entry %+v", signed)
	}
	if !open.CanAdopt || open.InPool || len(open.AccountIDs) != 1 {
		t.Fatalf("open entry %+v", open)
	}
	raw, _ := json.Marshal(view)
	if strings.Contains(string(raw), "hunter2") {
		t.Fatal("the view leaks a detected proxy's password")
	}
	if strings.Contains(signed.ID, "hunter2") || !strings.HasPrefix(signed.ID, "dx_") {
		t.Fatalf("detected id %q", signed.ID)
	}
	// Detected proxies are never routed to by the pool.
	for i := 0; i < 4; i++ {
		if r := m.Resolve(addAccount(t, "p"+string(rune('0'+i)), "")); r.ProxyID != "px_a" {
			t.Fatalf("a pooled account went to %+v", r)
		}
	}
}

func TestAdoptOnlyUnauthenticatedDetectedProxies(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	addAccount(t, "own", "socks5://alice:hunter2-secret@own.example:1080")
	addAccount(t, "plain", "http://open.example:8080")
	var signedID, openID string
	for _, d := range m.View().Detected {
		if d.Username != "" {
			signedID = d.ID
		} else {
			openID = d.ID
		}
	}
	if _, err := m.Adopt(signedID); !errors.Is(err, ErrDetectedSignIn) {
		t.Fatalf("adopting a signed-in proxy: %v", err)
	}
	p, err := m.Adopt(openID)
	if err != nil || p.URL != "http://open.example:8080" || p.Username != "" {
		t.Fatalf("adopt: %+v %v", p, err)
	}
	if _, err := m.Adopt(openID); !errors.Is(err, ErrDetectedInPool) {
		t.Fatalf("adopting twice: %v", err)
	}
	for _, d := range m.View().Detected {
		if d.ID == openID && (!d.InPool || d.CanAdopt) {
			t.Fatalf("adopted entry %+v", d)
		}
	}
	if _, err := m.Adopt("dx_missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
}

func TestDetectedChecksCountStrikesAndPersist(t *testing.T) {
	m := setupPool(t)
	setPoolSettings(t, config.ProxyPoolModeOff, false)
	addAccount(t, "own", closedPortURL(t))
	id := m.View().Detected[0].ID
	for i := 1; i <= MaxFailures+1; i++ {
		h, err := m.CheckDetected(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if h.Failures != i {
			t.Fatalf("check %d: %+v", i, h)
		}
	}
	if d := m.View().Detected[0]; d.State != StateUnhealthy || m.View().Counts.Unhealthy != 1 {
		t.Fatalf("detected entry %+v", d)
	}
	m.Flush()
	m.ResetForTest()
	if d := m.View().Detected[0]; d.ID != id || d.Health.Failures != MaxFailures+1 {
		t.Fatalf("after reload %+v, want the same id and strikes", d)
	}
	if _, err := m.CheckDetected(context.Background(), "dx_missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
}

func TestOutboundConnectionsReportToDetectedEntry(t *testing.T) {
	m := setupPool(t)
	dead := closedPortURL(t)
	addAccount(t, "own", dead)
	transport := BoundConnectReporting(&http.Transport{Proxy: http.ProxyURL(mustParse(t, dead))}, dead)
	resp, err := (&http.Client{Transport: transport}).Get("http://kiro.test/")
	if err == nil {
		resp.Body.Close()
		t.Fatal("expected a failure through a closed port")
	}
	if d := m.View().Detected[0]; d.Health.Failures != 1 || d.Health.ErrorCode != KindConnect {
		t.Fatalf("detected entry after a failed connection %+v", d)
	}
}

func mustParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
