// Package proxypool routes each account's outbound traffic: the account's own
// proxy first, then a sticky proxy from the pool, then the global proxy, then
// direct. It keeps every pool proxy's health, checks it on demand and on a
// timer, and moves accounts off a proxy that fails to connect.
package proxypool

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"kiro-proxy/textfmt"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

const (
	StatusUnknown = "unknown"
	StatusOK      = "ok"
	StatusFailed  = "failed"
)

// Route sources, in precedence order.
const (
	SourceAccount  = "account"
	SourcePool     = "pool"
	SourceFallback = "fallback"
	SourceGlobal   = "global"
	SourceDirect   = "direct"
)

// UnavailableURL is what ResolveURL returns when the pool has no proxy for an
// account and may not fall back. It is not a dialable URL: the proxy package
// maps it to a client that fails at once with ErrNoHealthyProxy.
const UnavailableURL = "proxypool://unavailable"

// Health is one proxy's last known state; times are Unix milliseconds.
type Health struct {
	Status    string `json:"status"`
	CheckedAt int64  `json:"checkedAt,omitempty"`
	FailedAt  int64  `json:"failedAt,omitempty"`
	LatencyMs int64  `json:"latencyMs,omitempty"`
	LastError string `json:"lastError,omitempty"`
	// ErrorCode is the last failure's Kind, for the admin UI's own wording; ErrorStatus is
	// the proxy's answer to CONNECT when it refused one.
	ErrorCode   string `json:"errorCode,omitempty"`
	ErrorStatus int    `json:"errorStatus,omitempty"`
}

// Route is where an account's traffic goes. URL is "" for direct.
type Route struct {
	URL         string
	ProxyID     string
	Source      string
	Unavailable bool
}

var (
	// persistDelay batches state writes: a check-all touches every proxy at once.
	persistDelay = 2 * time.Second
	// kickEvery bounds the background check-all an unavailable pool starts.
	kickEvery = 60 * time.Second
	// schedulerTick is how often the scheduler compares the clock with the interval.
	schedulerTick = 30 * time.Second
	// checkAllTimeout bounds one background check-all: a full pool of 100 at 8 at a time.
	checkAllTimeout = 3 * time.Minute
)

const checkParallelism = 8

type Manager struct {
	mu         sync.Mutex
	loaded     bool
	loadFailed bool
	gen        uint64
	health     map[string]*Health
	assign     map[string]string
	cursor     int
	lastFull   time.Time
	lastKick   time.Time
	timer      *time.Timer

	// Background checks run on bgCtx and are counted in bgRunning; ResetForTest
	// cancels them and waits on bgIdle, so none outlives the test that started it.
	bgCtx     context.Context
	bgCancel  context.CancelFunc
	bgRunning int
	bgIdle    *sync.Cond

	// adminMu serializes pool edits, each a read-modify-write of the config.
	adminMu sync.Mutex

	listenMu sync.RWMutex
	onChange []func()
	onState  []func()

	startOnce sync.Once
	now       func() time.Time
}

var defaultManager = newManager()

// Default is the process-wide manager.
func Default() *Manager { return defaultManager }

func newManager() *Manager {
	m := &Manager{
		health: make(map[string]*Health),
		assign: make(map[string]string),
		now:    time.Now,
	}
	m.bgCtx, m.bgCancel = context.WithCancel(context.Background())
	m.bgIdle = sync.NewCond(&m.mu)
	return m
}

// background registers one background check: it runs on the returned context
// and calls release when it ends.
func (m *Manager) background() (context.Context, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bgRunning++
	return m.bgCtx, func() {
		m.mu.Lock()
		m.bgRunning--
		m.bgIdle.Broadcast()
		m.mu.Unlock()
	}
}

// OnChange registers fn to run after the pool's proxies are added, edited or removed.
func (m *Manager) OnChange(fn func()) {
	m.listenMu.Lock()
	m.onChange = append(m.onChange, fn)
	m.listenMu.Unlock()
}

// OnStateChange registers fn to run after a proxy's status or the assignments change.
func (m *Manager) OnStateChange(fn func()) {
	m.listenMu.Lock()
	m.onState = append(m.onState, fn)
	m.listenMu.Unlock()
}

func (m *Manager) fire(change bool) {
	m.listenMu.RLock()
	fns := m.onState
	if change {
		fns = append(append([]func(){}, m.onChange...), m.onState...)
	}
	m.listenMu.RUnlock()
	for _, fn := range fns {
		fn()
	}
}

// ResetForTest ends every background check, then drops all in-memory state; the
// next call reloads it from the database.
func (m *Manager) ResetForTest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bgCancel()
	for m.bgRunning > 0 {
		m.bgIdle.Wait()
	}
	m.bgCtx, m.bgCancel = context.WithCancel(context.Background())
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	m.gen++
	m.loaded, m.loadFailed = false, false
	m.health = make(map[string]*Health)
	m.assign = make(map[string]string)
	m.cursor = 0
	m.lastFull, m.lastKick = time.Time{}, time.Time{}
}

type savedState struct {
	Health map[string]*Health `json:"health,omitempty"`
	Assign map[string]string  `json:"assign,omitempty"`
}

// ensureLoadedLocked reads the saved state once and reports whether it has been
// read. A failed read is tried again on the next call, and the saved state is
// not written over until it has been read.
func (m *Manager) ensureLoadedLocked() bool {
	if m.loaded {
		return true
	}
	raw, err := config.LoadProxyPoolState()
	if err != nil {
		if !m.loadFailed {
			logger.Warnf("[ProxyPool] Failed to load the pool state: %v", err)
		}
		m.loadFailed = true
		return false
	}
	m.loaded, m.loadFailed = true, false
	if raw == "" {
		return true
	}
	var state savedState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		logger.Warnf("[ProxyPool] Ignoring an unreadable pool state: %v", err)
		return true
	}
	//! What changed in memory while the read kept failing is newer than the saved state.
	for id, h := range state.Health {
		if _, seen := m.health[id]; h != nil && !seen {
			if h.LastError != "" && h.ErrorCode == "" {
				//! Saved before ErrorCode existed: the text starts with the kind's wording.
				if failure, ok := FailureOfText(h.LastError); ok {
					h.ErrorCode, h.ErrorStatus = failure.Kind, failure.Status
				}
			}
			m.health[id] = h
		}
	}
	for account, id := range state.Assign {
		if _, seen := m.assign[account]; !seen {
			m.assign[account] = id
		}
	}
	return true
}

// Load reads the saved health and assignments now instead of on first use.
func (m *Manager) Load() {
	m.mu.Lock()
	m.ensureLoadedLocked()
	m.mu.Unlock()
}

func (m *Manager) persistLocked() {
	if m.timer != nil {
		return
	}
	gen := m.gen
	m.timer = time.AfterFunc(persistDelay, func() { m.flush(gen) })
}

// Flush writes the state at once.
func (m *Manager) Flush() {
	m.mu.Lock()
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	gen := m.gen
	m.mu.Unlock()
	m.flush(gen)
}

func (m *Manager) flush(gen uint64) {
	proxies := proxyIDs(config.GetProxyPool())
	pooled := pooledAccounts()
	m.mu.Lock()
	if m.gen != gen {
		m.mu.Unlock()
		return
	}
	m.timer = nil
	if !m.ensureLoadedLocked() {
		m.mu.Unlock()
		return
	}
	//! Deleted proxies and accounts, and accounts that now have their own proxy, drop out here.
	for id := range m.health {
		if !proxies[id] {
			delete(m.health, id)
		}
	}
	for account, id := range m.assign {
		if !pooled[account] || !proxies[id] {
			delete(m.assign, account)
		}
	}
	data, err := json.Marshal(savedState{Health: m.health, Assign: m.assign})
	m.mu.Unlock()
	if err != nil {
		return
	}
	if err := config.SaveProxyPoolState(string(data)); err != nil {
		logger.Warnf("[ProxyPool] Failed to save the pool state: %v", err)
	}
}

func proxyIDs(pool []config.PoolProxy) map[string]bool {
	ids := make(map[string]bool, len(pool))
	for _, p := range pool {
		ids[p.ID] = true
	}
	return ids
}

// pooledAccounts is every account that would route through the pool: those without a proxy of their own.
func pooledAccounts() map[string]bool {
	accounts := config.GetAccounts()
	ids := make(map[string]bool, len(accounts))
	for _, a := range accounts {
		if a.ProxyURL == "" {
			ids[a.ID] = true
		}
	}
	return ids
}

func findProxy(pool []config.PoolProxy, id string) (config.PoolProxy, bool) {
	for _, p := range pool {
		if p.ID == id {
			return p, true
		}
	}
	return config.PoolProxy{}, false
}

func (m *Manager) healthLocked(id string) *Health {
	h := m.health[id]
	if h == nil {
		h = &Health{Status: StatusUnknown}
		m.health[id] = h
	}
	return h
}

// eligibleLocked: a proxy never checked counts as healthy until it fails.
func (m *Manager) eligibleLocked(id string) bool {
	h := m.health[id]
	return h == nil || h.Status != StatusFailed
}

// nextLocked picks the eligible proxy with the fewest accounts; ties go round-robin.
func (m *Manager) nextLocked(pool []config.PoolProxy, exclude string) (config.PoolProxy, bool) {
	n := len(pool)
	if n == 0 {
		return config.PoolProxy{}, false
	}
	load := make(map[string]int, n)
	for _, id := range m.assign {
		load[id]++
	}
	best := -1
	for i := 0; i < n; i++ {
		idx := (m.cursor + i) % n
		p := pool[idx]
		if p.ID == exclude || !m.eligibleLocked(p.ID) {
			continue
		}
		if best < 0 || load[p.ID] < load[pool[best].ID] {
			best = idx
		}
	}
	if best < 0 {
		return config.PoolProxy{}, false
	}
	m.cursor = (best + 1) % n
	return pool[best], true
}

// Resolve is the route for account, following account > pool > global > direct.
func (m *Manager) Resolve(account *config.Account) Route {
	if account != nil && account.ProxyURL != "" {
		return Route{URL: account.ProxyURL, Source: SourceAccount}
	}
	global := config.GetProxyURL()
	if config.GetProxyPoolMode() == config.ProxyPoolModeOn {
		if pool := config.GetProxyPool(); len(pool) > 0 {
			accountID := ""
			if account != nil {
				accountID = account.ID
			}
			if p, ok := m.pick(accountID, pool); ok {
				return Route{URL: FullURL(p), ProxyID: p.ID, Source: SourcePool}
			}
			//! With fallback on as well: with no periodic check, nothing else would bring the proxies back.
			m.kick()
			if config.GetProxyDirectFallback() {
				return Route{URL: global, Source: SourceFallback}
			}
			return Route{URL: UnavailableURL, Source: SourcePool, Unavailable: true}
		}
	}
	if global != "" {
		return Route{URL: global, Source: SourceGlobal}
	}
	return Route{Source: SourceDirect}
}

// ResolveURL is Resolve's URL; UnavailableURL when the pool has no proxy to give.
func (m *Manager) ResolveURL(account *config.Account) string {
	return m.Resolve(account).URL
}

func (m *Manager) pick(accountID string, pool []config.PoolProxy) (config.PoolProxy, bool) {
	m.mu.Lock()
	m.ensureLoadedLocked()
	if accountID != "" {
		if id, ok := m.assign[accountID]; ok && m.eligibleLocked(id) {
			if p, found := findProxy(pool, id); found {
				m.mu.Unlock()
				return p, true
			}
		}
	}
	p, ok := m.nextLocked(pool, "")
	changed := false
	if ok && accountID != "" {
		m.assign[accountID] = p.ID
		m.persistLocked()
		changed = true
	}
	m.mu.Unlock()
	if changed {
		m.fire(false)
	}
	return p, ok
}

// Assignment is the pool proxy an account is assigned to, if any.
func (m *Manager) Assignment(accountID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureLoadedLocked()
	id, ok := m.assign[accountID]
	return id, ok
}

// LookupURL finds the pool proxy whose dial URL is full.
func (m *Manager) LookupURL(full string) (config.PoolProxy, bool) {
	if full == "" || full == UnavailableURL {
		return config.PoolProxy{}, false
	}
	for _, p := range config.GetProxyPool() {
		if FullURL(p) == full {
			return p, true
		}
	}
	return config.PoolProxy{}, false
}

// Health is a copy of one proxy's state.
func (m *Manager) Health(id string) Health {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureLoadedLocked()
	if h := m.health[id]; h != nil {
		return *h
	}
	return Health{Status: StatusUnknown}
}

// ReportFailure marks proxy id failed and moves every account on it to the
// next eligible proxy. Accounts stay put when there is none.
func (m *Manager) ReportFailure(id string, cause error) {
	m.reportFailure(id, "", cause)
}

// reportFailure is ReportFailure for a request dialed at dialURL: once the proxy
// has been edited to another address or sign-in, the report is about the old
// one and is dropped. An empty dialURL always counts.
func (m *Manager) reportFailure(id, dialURL string, cause error) {
	pool := config.GetProxyPool()
	p, ok := findProxy(pool, id)
	if !ok || (dialURL != "" && FullURL(p) != dialURL) {
		return
	}
	m.mu.Lock()
	m.ensureLoadedLocked()
	h := m.healthLocked(id)
	wasFailed := h.Status == StatusFailed
	h.Status = StatusFailed
	h.FailedAt = m.now().UnixMilli()
	h.LatencyMs = 0
	h.noteFailure(cause, p)
	moved := m.moveAccountsLocked(pool, id)
	m.persistLocked()
	m.mu.Unlock()
	if !wasFailed || moved > 0 {
		kind := KindConnect
		var perr *ProxyError
		if errors.As(cause, &perr) {
			kind = perr.Kind
		}
		logger.Warnf("[ProxyPool] Proxy %s failed (%s); moved %s to other proxies", Name(p), kind, textfmt.Count(moved, "account", "accounts"))
		m.fire(false)
	}
}

func (m *Manager) moveAccountsLocked(pool []config.PoolProxy, id string) int {
	moved := 0
	for account, assigned := range m.assign {
		if assigned != id {
			continue
		}
		if next, ok := m.nextLocked(pool, id); ok {
			m.assign[account] = next.ID
			moved++
		}
	}
	return moved
}

// ReportSuccess marks proxy id healthy after a new connection through it.
func (m *Manager) ReportSuccess(id string) {
	m.reportSuccess(id, "")
}

// reportSuccess is ReportSuccess for a connection dialed at dialURL; like
// reportFailure, it is dropped once the proxy has been edited.
func (m *Manager) reportSuccess(id, dialURL string) {
	if dialURL != "" {
		if p, ok := findProxy(config.GetProxyPool(), id); !ok || FullURL(p) != dialURL {
			return
		}
	}
	m.mu.Lock()
	m.ensureLoadedLocked()
	h := m.health[id]
	if h != nil && h.Status == StatusOK {
		m.mu.Unlock()
		return
	}
	h = m.healthLocked(id)
	h.Status = StatusOK
	h.FailedAt = 0
	h.clearFailure()
	m.persistLocked()
	m.mu.Unlock()
	m.fire(false)
}

// noteFailure stores err as the last failure: its redacted text and its kind.
func (h *Health) noteFailure(err error, p config.PoolProxy) {
	h.LastError = errorText(err, p)
	h.ErrorCode, h.ErrorStatus = "", 0
	if failure, ok := Describe(err); ok {
		h.ErrorCode, h.ErrorStatus = failure.Kind, failure.Status
	}
}

func (h *Health) clearFailure() {
	h.LastError, h.ErrorCode, h.ErrorStatus = "", "", 0
}

// errorText is the stored last error: the failure kind, then the cause with every secret removed.
func errorText(err error, p config.PoolProxy) string {
	if err == nil {
		return ""
	}
	var perr *ProxyError
	if errors.As(err, &perr) {
		text := kindText(perr.Kind)
		if perr.cause != nil && perr.cause != ErrNoHealthyProxy {
			text += ": " + perr.cause.Error()
		}
		return Redact(text, p)
	}
	return Redact(err.Error(), p)
}

// CheckOne checks proxy id now and records the result.
func (m *Manager) CheckOne(ctx context.Context, id string) (Health, error) {
	p, ok := findProxy(config.GetProxyPool(), id)
	if !ok {
		return Health{}, ErrNotFound
	}
	m.mu.Lock()
	gen := m.gen
	m.mu.Unlock()
	latency, err := checkProxy(ctx, FullURL(p))
	if err != nil && ctx.Err() != nil {
		//! The caller's budget ran out or it went away: that says nothing about the proxy.
		//! A check's own 10 s timeout runs on a child context and still counts.
		m.mu.Lock()
		stale := m.gen != gen
		m.mu.Unlock()
		if stale {
			return Health{Status: StatusUnknown}, nil
		}
		return m.Health(id), nil
	}
	return m.recordCheck(gen, p, latency, err), nil
}

func (m *Manager) recordCheck(gen uint64, p config.PoolProxy, latency time.Duration, err error) Health {
	pool := config.GetProxyPool()
	m.mu.Lock()
	if m.gen != gen {
		m.mu.Unlock()
		return Health{Status: StatusUnknown}
	}
	m.ensureLoadedLocked()
	current, still := findProxy(pool, p.ID)
	if !still {
		m.mu.Unlock()
		return Health{Status: StatusUnknown}
	}
	if FullURL(current) != FullURL(p) {
		//! The proxy was edited while this check ran: the result is about the old address or sign-in.
		out := Health{Status: StatusUnknown}
		if h := m.health[p.ID]; h != nil {
			out = *h
		}
		m.mu.Unlock()
		return out
	}
	h := m.healthLocked(p.ID)
	before := h.Status
	now := m.now().UnixMilli()
	h.CheckedAt = now
	moved := 0
	if err == nil {
		h.Status = StatusOK
		h.FailedAt = 0
		h.clearFailure()
		h.LatencyMs = latency.Milliseconds()
		if h.LatencyMs == 0 && latency > 0 {
			h.LatencyMs = 1
		}
	} else {
		h.Status = StatusFailed
		h.FailedAt = now
		h.LatencyMs = 0
		h.noteFailure(err, p)
		moved = m.moveAccountsLocked(pool, p.ID)
	}
	m.persistLocked()
	out := *h
	m.mu.Unlock()
	if before != out.Status || moved > 0 {
		if out.Status == StatusFailed {
			logger.Warnf("[ProxyPool] Health check failed for %s: %s", Name(p), out.LastError)
		} else {
			logger.Infof("[ProxyPool] Proxy %s is healthy (%d ms)", Name(p), out.LatencyMs)
		}
		m.fire(false)
	}
	return out
}

// CheckAll checks every proxy, eight at a time.
func (m *Manager) CheckAll(ctx context.Context) {
	pool := config.GetProxyPool()
	m.mu.Lock()
	m.lastFull = m.now()
	m.mu.Unlock()
	sem := make(chan struct{}, checkParallelism)
	var wg sync.WaitGroup
	for _, p := range pool {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			_, _ = m.CheckOne(ctx, id)
		}(p.ID)
	}
	wg.Wait()
}

// kick starts a background check-all when the pool ran out of proxies, at most once a minute.
func (m *Manager) kick() {
	m.mu.Lock()
	if now := m.now(); now.Sub(m.lastKick) >= kickEvery {
		m.lastKick = now
		m.mu.Unlock()
		m.StartCheckAll()
		return
	}
	m.mu.Unlock()
}

// StartCheckAll runs CheckAll in the background with its own time budget and
// returns a channel that is closed when it ends.
func (m *Manager) StartCheckAll() <-chan struct{} {
	ctx, release := m.background()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer release()
		ctx, cancel := context.WithTimeout(ctx, checkAllTimeout)
		defer cancel()
		m.CheckAll(ctx)
	}()
	return done
}

// Start runs the periodic health check: while the pool is on and the interval
// is not 0, a check-all every interval minutes. Interval changes apply on the next tick.
func (m *Manager) Start() {
	m.startOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(schedulerTick)
			defer ticker.Stop()
			for range ticker.C {
				m.tick()
			}
		}()
	})
}

func (m *Manager) tick() {
	interval := config.GetProxyPoolCheckIntervalMin()
	if interval <= 0 || config.GetProxyPoolMode() != config.ProxyPoolModeOn || len(config.GetProxyPool()) == 0 {
		return
	}
	m.mu.Lock()
	due := m.now().Sub(m.lastFull) >= time.Duration(interval)*time.Minute
	m.mu.Unlock()
	if due {
		<-m.StartCheckAll()
	}
}

// checkSoon checks a new or edited proxy in the background.
func (m *Manager) checkSoon(id string) {
	ctx, release := m.background()
	go func() {
		defer release()
		ctx, cancel := context.WithTimeout(ctx, checkTotalTimeout+time.Second)
		defer cancel()
		_, _ = m.CheckOne(ctx, id)
	}()
}

func newProxyID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "px_" + hex.EncodeToString(b[:])
}

// Add stores a new proxy and checks it in the background.
func (m *Manager) Add(in ProxyInput) (config.PoolProxy, error) {
	m.adminMu.Lock()
	defer m.adminMu.Unlock()
	pool := config.GetProxyPool()
	if len(pool) >= MaxProxies {
		return config.PoolProxy{}, ErrFull
	}
	p, err := buildProxy(in, nil)
	if err != nil {
		return config.PoolProxy{}, err
	}
	for _, other := range pool {
		if identity(other) == identity(p) {
			return config.PoolProxy{}, ErrDuplicate
		}
	}
	p.ID = newProxyID()
	p.CreatedAt = m.now().UnixMilli()
	if err := config.SetProxyPool(append(pool, p)); err != nil {
		return config.PoolProxy{}, err
	}
	m.mu.Lock()
	m.ensureLoadedLocked()
	m.health[p.ID] = &Health{Status: StatusUnknown}
	m.persistLocked()
	m.mu.Unlock()
	m.fire(true)
	m.checkSoon(p.ID)
	return p, nil
}

// Update edits proxy id. A new address or sign-in resets its health and checks it again.
func (m *Manager) Update(id string, in ProxyInput) (config.PoolProxy, error) {
	m.adminMu.Lock()
	defer m.adminMu.Unlock()
	pool := config.GetProxyPool()
	index := -1
	for i, p := range pool {
		if p.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return config.PoolProxy{}, ErrNotFound
	}
	current := pool[index]
	p, err := buildProxy(in, &current)
	if err != nil {
		return config.PoolProxy{}, err
	}
	for i, other := range pool {
		if i != index && identity(other) == identity(p) {
			return config.PoolProxy{}, ErrDuplicate
		}
	}
	pool[index] = p
	if err := config.SetProxyPool(pool); err != nil {
		return config.PoolProxy{}, err
	}
	rewired := FullURL(p) != FullURL(current)
	if rewired {
		m.mu.Lock()
		m.ensureLoadedLocked()
		m.health[id] = &Health{Status: StatusUnknown}
		m.persistLocked()
		m.mu.Unlock()
	}
	m.fire(true)
	if rewired {
		m.checkSoon(id)
	}
	return p, nil
}

// Remove deletes proxy id and moves its accounts to the other proxies.
func (m *Manager) Remove(id string) error {
	m.adminMu.Lock()
	defer m.adminMu.Unlock()
	pool := config.GetProxyPool()
	kept := make([]config.PoolProxy, 0, len(pool))
	for _, p := range pool {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	if len(kept) == len(pool) {
		return ErrNotFound
	}
	if err := config.SetProxyPool(kept); err != nil {
		return err
	}
	m.mu.Lock()
	m.ensureLoadedLocked()
	delete(m.health, id)
	for account, assigned := range m.assign {
		if assigned != id {
			continue
		}
		if next, ok := m.nextLocked(kept, ""); ok {
			m.assign[account] = next.ID
		} else {
			delete(m.assign, account)
		}
	}
	m.persistLocked()
	m.mu.Unlock()
	m.fire(true)
	return nil
}
