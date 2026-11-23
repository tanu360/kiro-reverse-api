package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tailcfg/nodecap"
)

// waitFunnel hands back the status that shows Funnel on. The one from sign-in came before HTTPS
// was turned on and has no certificate domain, and the device name may change when it is.
func TestWaitFunnelReturnsTheStatusThatShowsFunnelOn(t *testing.T) {
	defer func(p time.Duration) { funnelPoll = p }(funnelPoll)
	funnelPoll = time.Millisecond

	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/localapi/v0/status", func(w http.ResponseWriter, r *http.Request) {
		st := &ipnstate.Status{
			BackendState: "Running",
			Self:         &ipnstate.PeerStatus{DNSName: "kiro-proxy.tail1234.ts.net."},
		}
		if calls.Add(1) > 1 {
			st.Self.DNSName = "kiro-proxy.example-tailnet.ts.net."
			st.Self.CapMap = tailcfg.NodeCapMap{
				nodecap.HTTPS:                      nil,
				nodecap.Funnel:                     nil,
				nodecap.FunnelPorts + "?ports=443": nil,
			}
			st.CertDomains = []string{"kiro-proxy.example-tailnet.ts.net"}
		}
		json.NewEncoder(w).Encode(st)
	})
	mux.HandleFunc("/localapi/v0/query-feature", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(tailcfg.QueryFeatureResponse{URL: "https://login.tailscale.com/f/funnel?node=x"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	var out bytes.Buffer
	tun := &tunnel{status: newStatusWriter(&out)}
	lc := &local.Client{OmitAuth: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, srv.Listener.Addr().String())
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := tun.waitFunnel(ctx, lc)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.CertDomains) != 1 || st.CertDomains[0] != "kiro-proxy.example-tailnet.ts.net" {
		t.Fatalf("CertDomains = %v, want the domain from the status that shows Funnel on", st.CertDomains)
	}
	if !bytes.Contains(out.Bytes(), []byte(`"state":"needs-funnel"`)) {
		t.Fatalf("no needs-funnel line before Funnel came on: %s", out.String())
	}
}
