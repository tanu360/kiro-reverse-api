// Package proxypool routes each account's outbound traffic: the account's own
// proxy first, then a sticky proxy from the pool, then the global proxy, then
// direct. It keeps every pool proxy's health, checks it on demand and on a
// timer, and moves accounts off a proxy that fails to connect three times in a
// row. It also health-checks the proxies in use outside the pool (the global
// proxy and accounts' own), shown as detected entries.
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

// MaxFailures is how many failed checks or connections in a row take a pool
// proxy out of rotation. One success resets the count.
const MaxFailures = 3

// failureThreshold is MaxFailures; a test may lower it.
var failureThreshold = MaxFailures

// Health is one proxy's last known state; times are Unix milliseconds. Status
// is "failed" only once Failures reached the threshold: the proxy is then
// disabled automatically until a check or a connection through it succeeds.
type Health struct {
	Status string `json:"status"`
	// Failures counts the failed checks and connections since the last success.
	Failures  int    `json:"failures,omitempty"`
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

	// detected is the health of the proxies in use outside the pool, by detected id.
	detected map[string]*Health
	// detectKey keys detected ids, so an id never reveals the proxy's password.
	detectKey []byte

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
		health:   make(map[string]*Health),
		assign:   make(map[string]string),
		detected: make(map[string]*Health),
		now:      time.Now,
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
	m.detected = make(map[string]*Health)
	m.detectKey = nil
	m.cursor = 0
	m.lastFull, m.lastKick = time.Time{}, time.Time{}
}

type savedState struct {
	Health    map[string]*Health `json:"health,omitempty"`
	Assign    map[string]string  `json:"assign,omitempty"`
	Detected  map[string]*Health `json:"detected,omitempty"`
	DetectKey string             `json:"detectKey,omitempty"`
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
		m.ensureDetectKeyLocked()
		return true
	}
	var state savedState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		logger.Warnf("[ProxyPool] Ignoring an unreadable pool state: %v", err)
		m.ensureDetectKeyLocked()
		return true
	}
	if key, err := hex.DecodeString(state.DetectKey); err == nil && len(key) == detectKeyBytes {
		m.detectKey = key
	}
	m.ensureDetectKeyLocked()
	for id, h := range state.Detected {
		if _, seen := m.detected[id]; h != nil && !seen {
			m.detected[id] = h
		}
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
			if h.Status == StatusFailed && h.Failures < failureThreshold {
				//! Saved before the strike count: a failed proxy stays out until a check passes.
				h.Failures = failureThreshold
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
	inUse := detectedInUse()
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
	detectedIDs := make(map[string]bool, len(inUse))
	for fullURL := range inUse {
		detectedIDs[m.detectedIDLocked(fullURL)] = true
	}
	for id := range m.detected {
		if !detectedIDs[id] {
			delete(m.detected, id)
		}
	}
	data, err := json.Marshal(savedState{Health: m.health, Assign: m.assign, Detected: m.detected, DetectKey: hex.EncodeToString(m.detectKey)})
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

// eligibleLocked: a proxy switched off never serves; one never checked counts
// as healthy until it fails three times in a row.
func (m *Manager) eligibleLocked(p config.PoolProxy) bool {
	if p.Disabled {
		return false
	}
	h := m.health[p.ID]
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
		if p.ID == exclude || !m.eligibleLocked(p) {
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
		if id, ok := m.assign[accountID]; ok {
			if p, found := findProxy(pool, id); found && m.eligibleLocked(p) {
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

// ReportFailure counts a failed connection through proxy id. The third in a
// row marks it failed and moves every account on it to the next eligible
// proxy; accounts stay put when there is none.
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
	h.noteFailure(cause, p)
	h.Failures++
	h.LatencyMs = 0
	moved := 0
	if h.Failures >= failureThreshold {
		h.Status = StatusFailed
		h.FailedAt = m.now().UnixMilli()
		moved = m.moveAccountsLocked(pool, id)
	}
	failures := h.Failures
	failed := h.Status == StatusFailed
	m.persistLocked()
	m.mu.Unlock()
	kind := KindConnect
	var perr *ProxyError
	if errors.As(cause, &perr) {
		kind = perr.Kind
	}
	switch {
	case failed && (!wasFailed || moved > 0):
		logger.Warnf("[ProxyPool] Proxy %s failed %d times in a row (%s); disabled it and moved %s to other proxies", Name(p), failures, kind, textfmt.Count(moved, "account", "accounts"))
	case !failed:
		logger.Warnf("[ProxyPool] Proxy %s failed (%s), %d of %d before it is disabled", Name(p), kind, failures, failureThreshold)
	}
	m.fire(false)
}

// Detour moves one account off proxy id after its request failed there, so the
// retry takes another route at once while the proxy itself only gains a strike.
// It reports whether the account moved: not when the proxy was disabled already
// (its accounts moved with it), the account is elsewhere, or no other proxy is eligible.
func (m *Manager) Detour(accountID, id string) bool {
	if accountID == "" || id == "" {
		return false
	}
	pool := config.GetProxyPool()
	m.mu.Lock()
	m.ensureLoadedLocked()
	if m.assign[accountID] != id {
		m.mu.Unlock()
		return false
	}
	next, ok := m.nextLocked(pool, id)
	if !ok {
		m.mu.Unlock()
		return false
	}
	m.assign[accountID] = next.ID
	m.persistLocked()
	m.mu.Unlock()
	logger.Infof("[ProxyPool] Moved one account from %s to %s after a failed connection", proxyName(pool, id), Name(next))
	m.fire(false)
	return true
}

func proxyName(pool []config.PoolProxy, id string) string {
	if p, ok := findProxy(pool, id); ok {
		return Name(p)
	}
	return id
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
	if h != nil && h.Status == StatusOK && h.Failures == 0 {
		m.mu.Unlock()
		return
	}
	h = m.healthLocked(id)
	h.Status = StatusOK
	h.FailedAt = 0
	h.Failures = 0
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
	moved := 0
	beforeFailures := h.Failures
	h.applyCheck(now, latency, err, p)
	if h.Status == StatusFailed && before != StatusFailed {
		moved = m.moveAccountsLocked(pool, p.ID)
	}
	m.persistLocked()
	out := *h
	m.mu.Unlock()
	if before != out.Status || moved > 0 || beforeFailures != out.Failures {
		switch {
		case out.Status == StatusFailed && before != StatusFailed:
			logger.Warnf("[ProxyPool] Health check failed %d times in a row for %s, disabled it and moved %s: %s", out.Failures, Name(p), textfmt.Count(moved, "account", "accounts"), out.LastError)
		case out.Failures > 0:
			logger.Warnf("[ProxyPool] Health check failed for %s (%d of %d): %s", Name(p), out.Failures, failureThreshold, out.LastError)
		case before == StatusFailed:
			logger.Infof("[ProxyPool] Proxy %s passed its check and is back in rotation (%d ms)", Name(p), out.LatencyMs)
		default:
			logger.Infof("[ProxyPool] Proxy %s is healthy (%d ms)", Name(p), out.LatencyMs)
		}
		m.fire(false)
	}
	return out
}

// applyCheck records one check: a pass makes the proxy healthy and clears its
// strikes; a failure adds one, and the threshold marks it failed.
func (h *Health) applyCheck(now int64, latency time.Duration, err error, p config.PoolProxy) {
	h.CheckedAt = now
	if err == nil {
		h.Status = StatusOK
		h.FailedAt = 0
		h.Failures = 0
		h.clearFailure()
		h.LatencyMs = latency.Milliseconds()
		if h.LatencyMs == 0 && latency > 0 {
			h.LatencyMs = 1
		}
		return
	}
	h.LatencyMs = 0
	h.noteFailure(err, p)
	h.Failures++
	if h.Failures >= failureThreshold {
		if h.Status != StatusFailed {
			h.FailedAt = now
		}
		h.Status = StatusFailed
	}
}

// CheckAll checks every pool proxy that is switched on, and every detected
// proxy, eight at a time. A proxy switched off is not checked.
func (m *Manager) CheckAll(ctx context.Context) {
	pool := config.GetProxyPool()
	detected := m.detectedProxies()
	m.mu.Lock()
	m.lastFull = m.now()
	m.mu.Unlock()
	sem := make(chan struct{}, checkParallelism)
	var wg sync.WaitGroup
	run := func(check func()) {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			check()
		}()
	}
	for _, p := range pool {
		if ctx.Err() != nil {
			break
		}
		if p.Disabled {
			continue
		}
		id := p.ID
		run(func() { _, _ = m.CheckOne(ctx, id) })
	}
	for _, d := range detected {
		if ctx.Err() != nil {
			break
		}
		id := d.ID
		run(func() { _, _ = m.CheckDetected(ctx, id) })
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
	if interval <= 0 {
		return
	}
	poolInUse := config.GetProxyPoolMode() == config.ProxyPoolModeOn && len(config.GetProxyPool()) > 0
	if !poolInUse && len(m.detectedProxies()) == 0 {
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
	switchedOn := current.Disabled && !p.Disabled
	switchedOff := !current.Disabled && p.Disabled
	if rewired || switchedOn || switchedOff {
		m.mu.Lock()
		m.ensureLoadedLocked()
		if rewired || switchedOn {
			//! A proxy switched back on starts over: its old strikes are from before the switch.
			m.health[id] = &Health{Status: StatusUnknown}
		}
		if switchedOff {
			m.releaseAccountsLocked(pool, id)
		}
		m.persistLocked()
		m.mu.Unlock()
	}
	if switchedOff {
		logger.Infof("[ProxyPool] Proxy %s switched off; its accounts moved to other proxies", Name(p))
	} else if switchedOn {
		logger.Infof("[ProxyPool] Proxy %s switched on", Name(p))
	}
	m.fire(true)
	if (rewired && !p.Disabled) || switchedOn {
		m.checkSoon(id)
	}
	return p, nil
}

// releaseAccountsLocked moves every account on proxy id to the next eligible
// proxy, or drops its assignment when there is none.
func (m *Manager) releaseAccountsLocked(pool []config.PoolProxy, id string) {
	for account, assigned := range m.assign {
		if assigned != id {
			continue
		}
		if next, ok := m.nextLocked(pool, id); ok {
			m.assign[account] = next.ID
		} else {
			delete(m.assign, account)
		}
	}
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
	m.releaseAccountsLocked(kept, id)
	m.persistLocked()
	m.mu.Unlock()
	m.fire(true)
	return nil
}
