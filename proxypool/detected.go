package proxypool

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"sort"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// Detected proxy sources.
const (
	DetectedGlobal  = "global"
	DetectedAccount = "account"
)

const detectKeyBytes = 32

var (
	// ErrDetectedSignIn refuses to share a detected proxy that carries a sign-in: the
	// credentials belong to the account or the global setting that holds them.
	ErrDetectedSignIn = errors.New("a detected proxy with a sign-in cannot join the pool")
	// ErrDetectedInPool is a detected proxy that the pool holds already.
	ErrDetectedInPool = errors.New("this proxy is already in the pool")
)

// detectedProxy is a proxy in use outside the pool: the global proxy or an
// account's own. It is health-checked like a pool proxy and never shared.
type detectedProxy struct {
	ID       string
	FullURL  string
	Base     string
	Username string
	Password string
	Global   bool
	Accounts []string
}

func (d detectedProxy) signedIn() bool { return d.Username != "" || d.Password != "" }

// ensureDetectKeyLocked makes the key that turns a proxy URL into its detected id.
func (m *Manager) ensureDetectKeyLocked() {
	if len(m.detectKey) == detectKeyBytes {
		return
	}
	key := make([]byte, detectKeyBytes)
	_, _ = rand.Read(key)
	m.detectKey = key
}

// detectedIDLocked is the detected id of a full proxy URL. It is keyed, so the id
// of a proxy with a password cannot be used to guess that password.
func (m *Manager) detectedIDLocked(fullURL string) string {
	//! The saved key comes first: a key made before the state was read would change every id.
	m.ensureLoadedLocked()
	m.ensureDetectKeyLocked()
	mac := hmac.New(sha256.New, m.detectKey)
	mac.Write([]byte(fullURL))
	return "dx_" + hex.EncodeToString(mac.Sum(nil)[:6])
}

// detectedInUse is every full proxy URL in use outside the pool, mapped to true.
func detectedInUse() map[string]bool {
	urls := map[string]bool{}
	if global := strings.TrimSpace(config.GetProxyURL()); global != "" {
		urls[global] = true
	}
	for _, a := range config.GetAccounts() {
		if u := strings.TrimSpace(a.ProxyURL); u != "" {
			urls[u] = true
		}
	}
	return urls
}

// detectedProxies lists the proxies in use outside the pool, global first, then
// by address. A URL that does not parse is left out: it cannot be checked.
func (m *Manager) detectedProxies() []detectedProxy {
	global := strings.TrimSpace(config.GetProxyURL())
	byURL := map[string]*detectedProxy{}
	var order []string
	add := func(raw string) *detectedProxy {
		if d, ok := byURL[raw]; ok {
			return d
		}
		base, user, pass, ok := splitOutboundURL(raw)
		if !ok {
			return nil
		}
		d := &detectedProxy{FullURL: raw, Base: base, Username: user, Password: pass}
		byURL[raw] = d
		order = append(order, raw)
		return d
	}
	if global != "" {
		if d := add(global); d != nil {
			d.Global = true
		}
	}
	for _, a := range config.GetAccounts() {
		raw := strings.TrimSpace(a.ProxyURL)
		if raw == "" {
			continue
		}
		if d := add(raw); d != nil {
			d.Accounts = append(d.Accounts, a.ID)
		}
	}
	m.mu.Lock()
	out := make([]detectedProxy, 0, len(order))
	for _, raw := range order {
		d := *byURL[raw]
		d.ID = m.detectedIDLocked(raw)
		out = append(out, d)
	}
	m.mu.Unlock()
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Global != out[j].Global {
			return out[i].Global
		}
		return out[i].Base+"|"+out[i].Username < out[j].Base+"|"+out[j].Username
	})
	return out
}

// splitOutboundURL is a saved own or global proxy URL as scheme://host:port and its
// sign-in. An http or https URL without a port gets the scheme's default.
func splitOutboundURL(raw string) (base, user, pass string, ok bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", "", "", false
	}
	scheme := strings.ToLower(u.Scheme)
	port := u.Port()
	if port == "" {
		switch scheme {
		case "http":
			port = "80"
		case "https":
			port = "443"
		default:
			return "", "", "", false
		}
	}
	base = scheme + "://" + net.JoinHostPort(strings.ToLower(u.Hostname()), port)
	if u.User != nil {
		user = u.User.Username()
		pass, _ = u.User.Password()
	}
	return base, user, pass, true
}

func findDetected(list []detectedProxy, id string) (detectedProxy, bool) {
	for _, d := range list {
		if d.ID == id {
			return d, true
		}
	}
	return detectedProxy{}, false
}

// CheckDetected checks detected proxy id now and records the result.
func (m *Manager) CheckDetected(ctx context.Context, id string) (Health, error) {
	d, ok := findDetected(m.detectedProxies(), id)
	if !ok {
		return Health{}, ErrNotFound
	}
	m.mu.Lock()
	gen := m.gen
	m.mu.Unlock()
	latency, err := checkProxy(ctx, d.FullURL)
	if err != nil && ctx.Err() != nil {
		return m.DetectedHealth(id), nil
	}
	return m.recordDetected(gen, d, latency, err, true), nil
}

// recordDetected stores a check (or, when check is false, a connection) through
// detected proxy d. Its strikes are shown only: nothing routes around it.
func (m *Manager) recordDetected(gen uint64, d detectedProxy, latency time.Duration, err error, check bool) Health {
	view := config.PoolProxy{URL: d.Base, Username: d.Username, Password: d.Password}
	m.mu.Lock()
	if m.gen != gen {
		m.mu.Unlock()
		return Health{Status: StatusUnknown}
	}
	m.ensureLoadedLocked()
	h := m.detected[d.ID]
	if h == nil {
		h = &Health{Status: StatusUnknown}
		m.detected[d.ID] = h
	}
	before, beforeFailures := h.Status, h.Failures
	now := m.now().UnixMilli()
	if check {
		h.applyCheck(now, latency, err, view)
	} else if err != nil {
		checkedAt := h.CheckedAt
		h.applyCheck(now, 0, err, view)
		h.CheckedAt = checkedAt
	} else {
		if h.Status == StatusOK && h.Failures == 0 {
			m.mu.Unlock()
			return *h
		}
		h.Status, h.FailedAt, h.Failures = StatusOK, 0, 0
		h.clearFailure()
	}
	m.persistLocked()
	out := *h
	m.mu.Unlock()
	if before != out.Status || beforeFailures != out.Failures {
		name := detectedName(d)
		if out.Failures > 0 {
			logger.Warnf("[ProxyPool] Detected proxy %s failed (%d in a row): %s", name, out.Failures, out.LastError)
		} else {
			logger.Infof("[ProxyPool] Detected proxy %s is healthy", name)
		}
		m.fire(false)
	}
	return out
}

func detectedName(d detectedProxy) string {
	if d.Username != "" {
		return d.Base + " (user " + d.Username + ")"
	}
	return d.Base
}

// DetectedHealth is a copy of one detected proxy's state.
func (m *Manager) DetectedHealth(id string) Health {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureLoadedLocked()
	if h := m.detected[id]; h != nil {
		return *h
	}
	return Health{Status: StatusUnknown}
}

// reportOutbound records a connection through an own or the global proxy at
// fullURL: err nil for a new connection, else the failure before it existed.
func (m *Manager) reportOutbound(fullURL string, err error) {
	if fullURL == "" {
		return
	}
	m.mu.Lock()
	gen := m.gen
	id := m.detectedIDLocked(fullURL)
	m.mu.Unlock()
	d, ok := findDetected(m.detectedProxies(), id)
	if !ok {
		return
	}
	m.recordDetected(gen, d, 0, err, false)
}

// Adopt adds an unauthenticated detected proxy to the pool, where any account
// may use it. One with a sign-in is refused: its credentials are not the pool's.
func (m *Manager) Adopt(id string) (config.PoolProxy, error) {
	d, ok := findDetected(m.detectedProxies(), id)
	if !ok {
		return config.PoolProxy{}, ErrNotFound
	}
	if d.signedIn() {
		return config.PoolProxy{}, ErrDetectedSignIn
	}
	base := d.Base
	p, err := m.Add(ProxyInput{URL: &base})
	if errors.Is(err, ErrDuplicate) {
		return config.PoolProxy{}, ErrDetectedInPool
	}
	return p, err
}
