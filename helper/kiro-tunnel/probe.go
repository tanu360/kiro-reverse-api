package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"
)

// headerProbe carries a one-off token on the request the helper sends itself through the public
// link. The helper answers that request itself, so the proxy never sees it.
const headerProbe = "X-Kiro-Tunnel-Probe"

// publicResolvers look the link's name up the way a visitor's computer does. The system resolver
// can be Tailscale's MagicDNS, which sends a tailnet member straight to the device and so says
// nothing about Funnel.
var publicResolvers = []string{"1.1.1.1:53", "8.8.8.8:53"}

var (
	// publishPoll is the pause between checks while the link is not reachable yet.
	publishPoll = 3 * time.Second
	// publishWait is how long the helper checks before it shows the link anyway, since this
	// machine's own view of the internet may be the problem. Tailscale says a new public name
	// can take up to 10 minutes.
	publishWait = 10 * time.Minute
)

// probeHandler answers a request that carries token and passes every other request to next.
func probeHandler(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get(headerProbe); got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1 {
			w.Header().Set(headerProbe, token)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// prober checks the public link from the internet's side. Tailscale serves a Funnel link from
// relay servers. A relay that has not heard of the device yet accepts a visitor's connection and
// closes it, and the browser shows ERR_CONNECTION_CLOSED. That can last minutes after the device
// comes online.
type prober struct {
	token   string
	resolve func(ctx context.Context, host string) ([]netip.Addr, error)
	dial    func(ctx context.Context, network, addr string) (net.Conn, error)
	port    uint16
	roots   *x509.CertPool // nil means the system's
}

func newProber() *prober {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return &prober{
		token:   hex.EncodeToString(b),
		resolve: publicLookup,
		dial:    (&net.Dialer{}).DialContext,
		port:    443,
	}
}

type probeResult int

const (
	// probeUnreachable: no connection, such as IPv6 on a machine without it. Says nothing
	// about the link.
	probeUnreachable probeResult = iota
	// probeFailed: connected, but the helper did not answer.
	probeFailed
	// probeAnswered: the request went through the relay and reached this helper.
	probeAnswered
)

// live reports whether every address of host that this machine can reach leads to this helper,
// and at least one does. A visitor's browser may pick any of them.
func (p *prober) live(ctx context.Context, host string) bool {
	addrs, err := p.resolve(ctx, host)
	if err != nil || len(addrs) == 0 {
		return false
	}
	results := make([]probeResult, len(addrs))
	var wg sync.WaitGroup
	for i, addr := range addrs {
		wg.Go(func() { results[i] = p.check(ctx, host, addr) })
	}
	wg.Wait()
	answered := 0
	for _, r := range results {
		switch r {
		case probeFailed:
			return false
		case probeAnswered:
			answered++
		}
	}
	return answered > 0
}

// check sends the token to one address of host.
func (p *prober) check(ctx context.Context, host string, addr netip.Addr) probeResult {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	dialCtx, cancelDial := context.WithTimeout(ctx, 5*time.Second)
	conn, err := p.dial(dialCtx, "tcp", netip.AddrPortFrom(addr.Unmap(), p.port).String())
	cancelDial()
	if err != nil {
		return probeUnreachable
	}
	tc := tls.Client(conn, &tls.Config{ServerName: host, RootCAs: p.roots, NextProtos: []string{"http/1.1"}})
	defer tc.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = tc.SetDeadline(deadline)
	}
	if err := tc.HandshakeContext(ctx); err != nil {
		return probeFailed
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+"/", nil)
	if err != nil {
		return probeFailed
	}
	req.Header.Set(headerProbe, p.token)
	req.Close = true
	if err := req.Write(tc); err != nil {
		return probeFailed
	}
	resp, err := http.ReadResponse(bufio.NewReader(tc), req)
	if err != nil {
		return probeFailed
	}
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent && resp.Header.Get(headerProbe) == p.token {
		return probeAnswered
	}
	return probeFailed
}

// publicLookup asks the public resolvers for host's addresses. A name they do not know is not
// published yet. If neither can be reached, as on a network that blocks outside DNS, the system
// resolver answers instead.
func publicLookup(ctx context.Context, host string) ([]netip.Addr, error) {
	for _, server := range publicResolvers {
		r := &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, server)
			},
		}
		lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		addrs, err := r.LookupNetIP(lookupCtx, "ip", host)
		cancel()
		if err == nil {
			return addrs, nil
		}
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return nil, err
		}
	}
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// waitPublished returns true once the link answers from the internet or publishWait has passed,
// and false if ctx ends first.
func (p *prober) waitPublished(ctx context.Context, host string) bool {
	deadline := time.Now().Add(publishWait)
	for {
		if p.live(ctx, host) || time.Now().After(deadline) {
			return ctx.Err() == nil
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(publishPoll):
		}
	}
}
