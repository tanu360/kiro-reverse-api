package proxy

import (
	"context"
	"net/http"
	"testing"

	"kiro-proxy/config"
)

func TestAlertDirectHost(t *testing.T) {
	for host, want := range map[string]bool{
		"127.0.0.1": true, "::1": true, "localhost": true, "10.1.2.3": true, "192.168.1.20": true,
		"172.16.0.5": true, "169.254.1.1": true, "fd00::1": true, "n8n": true, "hass.local": true,
		"box.lan": true, "svc.internal": true, "api.telegram.org": false, "hooks.slack.com": false,
		"8.8.8.8": false, "discord.com": false, "": false,
	} {
		if got := alertDirectHost(host); got != want {
			t.Errorf("alertDirectHost(%q) = %v, want %v", host, got, want)
		}
	}
}

// A global outbound proxy (needed to reach AWS) must not swallow a webhook on this host.
func TestAlertClientSkipsTheProxyForALocalReceiver(t *testing.T) {
	initAlertsTest(t)
	fastAlertRetries(t)
	if err := config.UpdateProxySettings("http://127.0.0.1:9"); err != nil {
		t.Fatal(err)
	}
	srv, got := alertReceiver(t)
	client := alertHTTPClient()
	ch := config.AlertChannel{ID: "ch_1", Type: config.AlertChannelWebhook, Name: "local", Enabled: true, URL: srv.URL + "/hook"}
	if d := sendAlert(context.Background(), client, ch, testAlertMessage(1), 0); !d.OK || len(got()) != 1 {
		t.Fatalf("local delivery through the proxy: %+v, received %d", d, len(got()))
	}

	transport := client.Transport.(*http.Transport)
	req, _ := http.NewRequest(http.MethodPost, "https://api.telegram.org/bot/sendMessage", nil)
	if u, err := transport.Proxy(req); err != nil || u == nil || u.Host != "127.0.0.1:9" {
		t.Fatalf("a public receiver must keep the outbound proxy: %v %v", u, err)
	}
}
