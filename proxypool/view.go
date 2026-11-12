package proxypool

import "kiro-proxy/config"

// ProxyView is a proxy as the admin API shows it: the address without sign-in,
// the username, and only whether a password is stored.
type ProxyView struct {
	ID          string `json:"id"`
	Label       string `json:"label,omitempty"`
	URL         string `json:"url"`
	Username    string `json:"username,omitempty"`
	HasPassword bool   `json:"hasPassword"`
	CreatedAt   int64  `json:"createdAt,omitempty"`
	Accounts    int    `json:"accounts"`
	Health      Health `json:"health"`
}

// View is the whole pool for the admin API.
type View struct {
	Mode             string            `json:"mode"`
	DirectFallback   bool              `json:"directFallback"`
	CheckIntervalMin int               `json:"checkIntervalMin"`
	Proxies          []ProxyView       `json:"proxies"`
	Assignments      map[string]string `json:"assignments"`
}

func proxyView(p config.PoolProxy, health Health, accounts int) ProxyView {
	return ProxyView{
		ID:          p.ID,
		Label:       p.Label,
		URL:         DisplayURL(p),
		Username:    p.Username,
		HasPassword: p.Password != "",
		CreatedAt:   p.CreatedAt,
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

// View is the masked pool with each proxy's health and the accounts on it.
// Only accounts that route through the pool (no proxy of their own) count.
func (m *Manager) View() View {
	pool := config.GetProxyPool()
	pooled := pooledAccounts()
	proxies := proxyIDs(pool)
	view := View{
		Mode:             config.GetProxyPoolMode(),
		DirectFallback:   config.GetProxyDirectFallback(),
		CheckIntervalMin: config.GetProxyPoolCheckIntervalMin(),
		Proxies:          make([]ProxyView, 0, len(pool)),
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
	m.mu.Unlock()
	for _, p := range pool {
		view.Proxies = append(view.Proxies, proxyView(p, health[p.ID], counts[p.ID]))
	}
	return view
}
