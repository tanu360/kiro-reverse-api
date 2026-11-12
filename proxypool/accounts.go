package proxypool

// ForgetAccounts drops the pool assignments of accounts that no longer exist, such as the
// copies a duplicate merge removed. They stop counting toward a proxy's load at once,
// instead of at the next state save.
func (m *Manager) ForgetAccounts(ids ...string) {
	m.mu.Lock()
	m.ensureLoadedLocked()
	changed := false
	for _, id := range ids {
		if _, ok := m.assign[id]; ok {
			delete(m.assign, id)
			changed = true
		}
	}
	if changed {
		m.persistLocked()
	}
	m.mu.Unlock()
	if changed {
		m.fire(false)
	}
}
