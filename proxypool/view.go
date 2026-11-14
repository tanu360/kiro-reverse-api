package proxypool

import "kiro-proxy/config"

// States a proxy shows as, derived from its switch and health.
const (
	StateHealthy      = "healthy"
	StateUnknown      = "unknown"
	StateUnhealthy    = "unhealthy"
	StateAutoDisabled = "auto_disabled"
	StateOff          = "off"
)

// ProxyView is a proxy as the admin API shows it: the address without sign-in,
// the username, and only whether a password is stored.
type ProxyView struct {
	ID          string `json:"id"`
	Label       string `json:"label,omitempty"`
	URL         string `json:"url"`
	Username    string `json:"username,omitempty"`
	HasPassword bool   `json:"hasPassword"`
	CreatedAt   int64  `json:"createdAt,omitempty"`
	Enabled     bool   `json:"enabled"`
	// State is healthy, unknown (never checked), unhealthy (failing, still in
	// rotation), auto_disabled (failed MaxFailures times in a row) or off.
	State    string `json:"state"`
	Accounts int    `json:"accounts"`
	Health   Health `json:"health"`
}

// DetectedView is a proxy in use outside the pool. It is never shared with
// other accounts unless the admin adds it to the pool, and one with a sign-in
// cannot be added at all.
type DetectedView struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Username    string `json:"username,omitempty"`
	HasPassword bool   `json:"hasPassword"`
	// Global is the server-wide outbound proxy; AccountIDs are the accounts with
	// this proxy as their own.
	Global     bool     `json:"global"`
	AccountIDs []string `json:"accountIds"`
	// InPool is a detected proxy the pool holds too (same address, no sign-in).
	InPool bool `json:"inPool"`
	// CanAdopt is an unauthenticated proxy the pool does not hold yet.
	CanAdopt bool   `json:"canAdopt"`
	State    string `json:"state"`
	Health   Health `json:"health"`
}

// Counts is how many proxies are in each state; detected proxies count too.
type Counts struct {
	Healthy      int `json:"healthy"`
	Unhealthy    int `json:"unhealthy"`
	AutoDisabled int `json:"autoDisabled"`
	Off          int `json:"off"`
	Unknown      int `json:"unknown"`
}

func (c *Counts) add(state string) {
	switch state {
	case StateHealthy:
		c.Healthy++
	case StateUnhealthy:
		c.Unhealthy++
	case StateAutoDisabled:
		c.AutoDisabled++
	case StateOff:
		c.Off++
	default:
		c.Unknown++
	}
}

// View is the whole pool for the admin API.
type View struct {
	Mode             string            `json:"mode"`
	DirectFallback   bool              `json:"directFallback"`
	CheckIntervalMin int               `json:"checkIntervalMin"`
	MaxFailures      int               `json:"maxFailures"`
	Proxies          []ProxyView       `json:"proxies"`
	Detected         []DetectedView    `json:"detected"`
	Counts           Counts            `json:"counts"`
	Assignments      map[string]string `json:"assignments"`
}

// stateOf is a pool proxy's state from its switch and health.
func stateOf(disabled bool, h Health) string {
	switch {
	case disabled:
		return StateOff
	case h.Status == StatusFailed:
		return StateAutoDisabled
	case h.Failures > 0:
		return StateUnhealthy
	case h.Status == StatusOK:
		return StateHealthy
	default:
		return StateUnknown
	}
}

// detectedStateOf is a detected proxy's state: nothing disables it, so a run of
// failures leaves it unhealthy.
func detectedStateOf(h Health) string {
	switch {
	case h.Failures > 0 || h.Status == StatusFailed:
		return StateUnhealthy
	case h.Status == StatusOK:
		return StateHealthy
	default:
		return StateUnknown
	}
}

func proxyView(p config.PoolProxy, health Health, accounts int) ProxyView {
	return ProxyView{
		ID:          p.ID,
		Label:       p.Label,
		URL:         DisplayURL(p),
		Username:    p.Username,
		HasPassword: p.Password != "",
		CreatedAt:   p.CreatedAt,
		Enabled:     !p.Disabled,
		State:       stateOf(p.Disabled, health),
		Accounts:    accounts,
		Health:      health,
	}
}

// ViewProxy is one proxy's masked view with its current health and account count.
func (m *Manager) ViewProxy(p config.PoolProxy) ProxyView {
	for _, pv := range m.View().Proxies {
		if pv.ID == p.ID {
			return pv
		}
	}
	return proxyView(p, m.Health(p.ID), 0)
}

// ViewDetected is one detected proxy's view, if it is still in use.
func (m *Manager) ViewDetected(id string) (DetectedView, bool) {
	for _, dv := range m.View().Detected {
		if dv.ID == id {
			return dv, true
		}
	}
	return DetectedView{}, false
}

// View is the masked pool with each proxy's health and the accounts on it.
// Only accounts that route through the pool (no proxy of their own) count.
func (m *Manager) View() View {
	pool := config.GetProxyPool()
	pooled := pooledAccounts()
	proxies := proxyIDs(pool)
	detected := m.detectedProxies()
	view := View{
		Mode:             config.GetProxyPoolMode(),
		DirectFallback:   config.GetProxyDirectFallback(),
		CheckIntervalMin: config.GetProxyPoolCheckIntervalMin(),
		MaxFailures:      failureThreshold,
		Proxies:          make([]ProxyView, 0, len(pool)),
		Detected:         make([]DetectedView, 0, len(detected)),
		Assignments:      map[string]string{},
	}
	m.mu.Lock()
	m.ensureLoadedLocked()
	counts := map[string]int{}
	for account, id := range m.assign {
		if pooled[account] && proxies[id] {
			view.Assignments[account] = id
			counts[id]++
		}
	}
	health := make(map[string]Health, len(pool))
	for _, p := range pool {
		if h := m.health[p.ID]; h != nil {
			health[p.ID] = *h
		} else {
			health[p.ID] = Health{Status: StatusUnknown}
		}
	}
	detectedHealth := make(map[string]Health, len(detected))
	for _, d := range detected {
		if h := m.detected[d.ID]; h != nil {
			detectedHealth[d.ID] = *h
		} else {
			detectedHealth[d.ID] = Health{Status: StatusUnknown}
		}
	}
	m.mu.Unlock()
	pooledIdentity := make(map[string]bool, len(pool))
	for _, p := range pool {
		pv := proxyView(p, health[p.ID], counts[p.ID])
		view.Counts.add(pv.State)
		view.Proxies = append(view.Proxies, pv)
		pooledIdentity[identity(p)] = true
	}
	for _, d := range detected {
		h := detectedHealth[d.ID]
		inPool := pooledIdentity[identity(config.PoolProxy{URL: d.Base, Username: d.Username})] && !d.signedIn()
		accounts := d.Accounts
		if accounts == nil {
			accounts = []string{}
		}
		dv := DetectedView{
			ID:          d.ID,
			URL:         d.Base,
			Username:    d.Username,
			HasPassword: d.Password != "",
			Global:      d.Global,
			AccountIDs:  accounts,
			InPool:      inPool,
			CanAdopt:    !d.signedIn() && !inPool,
			State:       detectedStateOf(h),
			Health:      h,
		}
		view.Counts.add(dv.State)
		view.Detected = append(view.Detected, dv)
	}
	return view
}
