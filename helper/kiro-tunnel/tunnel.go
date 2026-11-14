package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

// adminMachinesURL is where a tailnet admin approves a new device.
const adminMachinesURL = "https://login.tailscale.com/admin/machines"

// fallbackFunnelURL is the policy page, for when the control server sends no enable link.
const fallbackFunnelURL = "https://login.tailscale.com/admin/acls/file"

// Poll intervals. Login and the Funnel switch are clicks in the user's browser, so a second or
// three is quick enough and costs nothing.
var (
	loginPoll  = time.Second
	funnelPoll = 3 * time.Second
	healthPoll = 5 * time.Second
)

type tunnel struct {
	srv    *tsnet.Server
	status *statusWriter
	target *url.URL
	secret string
}

// run walks the node from start to serving: sign-in, device approval, the tailnet's HTTPS and
// Funnel switches, then the listener. It keeps reporting while it serves, since a key that
// expires sends the node back to sign-in.
func (t *tunnel) run(ctx context.Context) error {
	if err := t.srv.Start(); err != nil {
		return fmt.Errorf("start Tailscale: %w", err)
	}
	lc, err := t.srv.LocalClient()
	if err != nil {
		return err
	}
	st, err := t.waitRunning(ctx, lc)
	if err != nil {
		return err
	}
	if err := t.waitFunnel(ctx, lc); err != nil {
		return err
	}

	ln, err := t.srv.ListenFunnel("tcp", ":443")
	if err != nil {
		return fmt.Errorf("open the Funnel listener: %w", err)
	}
	server := &http.Server{
		Handler:           newForwarder(t.target, t.secret),
		ConnContext:       connContext,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(ln) }()
	defer server.Close()

	// Fetch the certificate before the link goes out, so the first visitor does not wait for it.
	domain := strings.TrimSuffix(st.Self.DNSName, ".")
	if len(st.CertDomains) > 0 {
		domain = st.CertDomains[0]
	}
	certCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	_, _, _ = lc.CertPair(certCtx, domain)
	cancel()
	publicURL := "https://" + domain
	t.status.emit(Status{State: stateRunning, URL: publicURL})

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-serveErr:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return fmt.Errorf("serve: %w", err)
		case <-time.After(healthPoll):
		}
		cur, err := lc.StatusWithoutPeers(ctx)
		if err != nil {
			continue
		}
		if s, ok := loginStatus(cur); ok {
			t.status.emit(s)
		} else {
			t.status.emit(Status{State: stateRunning, URL: publicURL})
		}
	}
}

// waitRunning reports sign-in and approval until the node is up.
func (t *tunnel) waitRunning(ctx context.Context, lc *local.Client) (*ipnstate.Status, error) {
	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil {
			if st.BackendState == ipn.Running.String() && st.Self != nil {
				return st, nil
			}
			if s, ok := loginStatus(st); ok {
				t.status.emit(s)
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(loginPoll):
		}
	}
}

// loginStatus maps a node that is not up to what the user must do, if anything.
func loginStatus(st *ipnstate.Status) (Status, bool) {
	switch st.BackendState {
	case ipn.NeedsLogin.String():
		if st.AuthURL != "" {
			return Status{State: stateNeedsLogin, AuthURL: st.AuthURL}, true
		}
		return Status{State: stateStarting}, true
	case ipn.NeedsMachineAuth.String():
		return Status{State: stateNeedsApproval, AdminURL: adminMachinesURL}, true
	case ipn.Running.String():
		return Status{}, false
	default:
		return Status{State: stateStarting}, true
	}
}

// waitFunnel reports the tailnet's HTTPS and Funnel switches until both are on. The control
// server hands out a link that turns on both in one click, as `tailscale funnel` shows it.
func (t *tunnel) waitFunnel(ctx context.Context, lc *local.Client) error {
	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil && st.Self != nil {
			if ipn.CheckFunnelAccess(443, st.Self) == nil && len(st.CertDomains) > 0 {
				return nil
			}
			link := fallbackFunnelURL
			if resp, err := lc.QueryFeature(ctx, "funnel"); err == nil {
				if resp.Complete {
					// Turned on; the node's capabilities follow with the next netmap.
					link = ""
				} else if resp.URL != "" {
					link = resp.URL
				}
			}
			if link != "" {
				t.status.emit(Status{State: stateNeedsFunnel, EnableURL: link})
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(funnelPoll):
		}
	}
}
