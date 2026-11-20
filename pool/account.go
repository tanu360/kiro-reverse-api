package pool

import (
	"kiro-proxy/config"
	"strings"
	"sync"
	"time"
)

const tokenRefreshSkewSeconds int64 = 120

type AccountPool struct {
	mu sync.RWMutex
	// accounts holds each account in rotation once, in account-list order, which
	// priority and reset-first ties fall back to.
	accounts []config.Account
	// rotation is the weighted cycle as indexes into accounts: an account with
	// weight N takes N slots, spread through the cycle (rotationOrder).
	rotation      []int
	totalAccounts int
	// currentIndex is the next slot of rotation to try.
	currentIndex uint64
	cooldowns    map[string]time.Time
	// cooldownKinds says what set each cooldown, so self-heal never clears a quota one.
	cooldownKinds map[string]CooldownKind
	errorCounts   map[string]int
	modelLists    map[string]map[string]bool
	// refusedModels holds, per account, the models Kiro refused for it (INVALID_MODEL_ID) since
	// its model list was last set. A refusal outranks the list, which may be unknown or stale.
	refusedModels map[string]map[string]bool
	// enabledIDs lists every enabled account, including over-limit ones Reload keeps out of rotation.
	enabledIDs []string
	// rpm holds recent starts per account for the optional RPM limit (rpm_limit.go).
	rpm rpmStarts
	// spend is each account's credits since its last usage refresh (reset_first.go).
	spend map[string]localSpend
}

var (
	pool     *AccountPool
	poolOnce sync.Once
)

func GetPool() *AccountPool {
	poolOnce.Do(func() {
		pool = &AccountPool{
			cooldowns:   make(map[string]time.Time),
			errorCounts: make(map[string]int),
			modelLists:  make(map[string]map[string]bool),
		}
		pool.Reload()
		if err := pool.loadCooldowns(); err != nil {
			_ = err
		}
	})
	return pool
}

func (p *AccountPool) Reload() {
	p.mu.Lock()
	defer p.mu.Unlock()
	enabled := config.GetEnabledAccounts()
	allowOverUsage := config.GetAllowOverUsage()
	var inRotation []config.Account
	enabledIDs := make([]string, 0, len(enabled))
	for _, a := range enabled {
		enabledIDs = append(enabledIDs, a.ID)
		if isOverUsageLimit(a) && !isUpstreamOverageEnabled(a) && !allowOverUsage {
			continue
		}
		inRotation = append(inRotation, a)
	}
	p.setAccountsLocked(inRotation)
	p.enabledIDs = enabledIDs
	p.totalAccounts = len(enabled)
}

// setAccountsLocked puts accounts in rotation and rebuilds the weighted cycle.
// The cursor keeps its place, so a reload does not send the next request back
// to the first account.
func (p *AccountPool) setAccountsLocked(accounts []config.Account) {
	p.accounts = accounts
	p.rotation = rotationOrder(accounts)
	if len(p.rotation) == 0 {
		p.currentIndex = 0
	} else if p.currentIndex >= uint64(len(p.rotation)) {
		p.currentIndex %= uint64(len(p.rotation))
	}
}

// rotationOrder is the weighted cycle for accounts, as indexes into it: smooth
// weighted round-robin, as nginx orders its upstreams. Every slot each account
// adds its weight to a running score, the highest score takes the slot (the
// earliest account on a tie) and gives back the total weight. An account with
// weight N gets N slots of the cycle, spread through it rather than in a row,
// so equal weights are a plain round robin in list order.
//
// Weights are divided by their greatest common divisor first: 10 and 20 rotate
// like 1 and 2, in a cycle of 3 slots instead of 30.
func rotationOrder(accounts []config.Account) []int {
	if len(accounts) == 0 {
		return nil
	}
	weights := make([]int, len(accounts))
	divisor := 0
	for i := range accounts {
		weights[i] = effectiveWeight(accounts[i].Weight)
		divisor = gcd(divisor, weights[i])
	}
	total := 0
	for i := range weights {
		weights[i] /= divisor
		total += weights[i]
	}
	scores := make([]int, len(accounts))
	order := make([]int, 0, total)
	for len(order) < total {
		best := 0
		for i, w := range weights {
			scores[i] += w
			if scores[i] > scores[best] {
				best = i
			}
		}
		scores[best] -= total
		order = append(order, best)
	}
	return order
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func (p *AccountPool) GetNext() *config.Account {
	return p.GetNextExcluding(nil)
}

func (p *AccountPool) GetNextExcluding(excluded map[string]bool) *config.Account {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.nextAccountLocked("", excluded, config.GetRoutingMode())
}

func (p *AccountPool) SetModelList(accountID string, modelIDs []string) {
	set := make(map[string]bool, len(modelIDs))
	for _, id := range modelIDs {
		set[strings.ToLower(strings.TrimSpace(id))] = true
	}
	p.mu.Lock()
	p.modelLists[accountID] = set
	//! A fresh listing is the account's word on its models again.
	delete(p.refusedModels, accountID)
	p.mu.Unlock()
}

// MarkModelRefused records that Kiro refused model for the account (INVALID_MODEL_ID), so no
// pick sends it that model again until the account's model list is set anew. Its list can be
// unknown (before the first listing, after a profile change, after a failed listing), which
// lets every model through, or out of date.
func (p *AccountPool) MarkModelRefused(accountID, model string) {
	key := strings.ToLower(strings.TrimSpace(model))
	if accountID == "" || key == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.refusedModels == nil {
		p.refusedModels = make(map[string]map[string]bool)
	}
	if p.refusedModels[accountID] == nil {
		p.refusedModels[accountID] = make(map[string]bool)
	}
	p.refusedModels[accountID][key] = true
}

func (p *AccountPool) GetModelList(accountID string) []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	set, ok := p.modelLists[accountID]
	if !ok || len(set) == 0 {
		return []string{}
	}
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	return ids
}

func (p *AccountPool) accountHasModel(accountID, model string) bool {
	key := strings.ToLower(strings.TrimSpace(model))
	if p.refusedModels[accountID][key] {
		return false
	}
	list, ok := p.modelLists[accountID]
	if !ok || len(list) == 0 {
		return true
	}
	return list[key]
}

// OffersModel reports whether some enabled account may serve model. An empty
// pool answers true, so callers keep reporting a capacity problem rather than
// blaming the model.
func (p *AccountPool) OffersModel(model string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if (len(p.accounts) == 0 && len(p.enabledIDs) == 0) || strings.TrimSpace(model) == "" {
		return true
	}
	//! Over-limit accounts are out of rotation but still offer their models: a model only
	//! they list is a quota problem (503), not an unknown model (404).
	for _, id := range p.enabledIDs {
		if p.accountHasModel(id, model) {
			return true
		}
	}
	for i := range p.accounts {
		if p.accountHasModel(p.accounts[i].ID, model) {
			return true
		}
	}
	return false
}

func (p *AccountPool) GetNextForModel(model string) *config.Account {
	return p.GetNextForModelExcluding(model, nil)
}

func (p *AccountPool) GetNextForModelExcluding(model string, excluded map[string]bool) *config.Account {
	return p.getNextForModel(model, excluded, "")
}

// getNextForModel is GetNextForModelExcluding with a routing mode; "" (or an
// unknown mode) is the global one.
func (p *AccountPool) getNextForModel(model string, excluded map[string]bool, mode string) *config.Account {
	mode = resolveRoutingMode(mode)
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.nextAccountLocked(model, excluded, mode)
}

// resolveRoutingMode is mode when it is a routing mode, and the global routing
// mode otherwise ("" follows the global mode).
func resolveRoutingMode(mode string) string {
	if config.ValidRoutingMode(mode) {
		return mode
	}
	return config.GetRoutingMode()
}

// GetPreferredForModelExcluding returns preferredID when that account can serve
// model right now, and the routing mode's pick otherwise. In priority mode an
// account with a better priority that can serve wins over preferredID as well;
// one with the same priority does not. In reset-first mode an account whose
// credits reset on an earlier day wins over preferredID; one resetting the same
// day does not. A preferred hit leaves the rotation cursor alone, so sticky
// conversations do not skew where new conversations land.
func (p *AccountPool) GetPreferredForModelExcluding(preferredID, model string, excluded map[string]bool) *config.Account {
	return p.getPreferredForModel(preferredID, model, excluded, "")
}

// getPreferredForModel is GetPreferredForModelExcluding with a routing mode;
// "" (or an unknown mode) is the global one.
func (p *AccountPool) getPreferredForModel(preferredID, model string, excluded map[string]bool, mode string) *config.Account {
	mode = resolveRoutingMode(mode)
	p.mu.Lock()
	defer p.mu.Unlock()

	if preferredID != "" {
		allowOverUsage := config.GetAllowOverUsage()
		now := time.Now()
		for i := range p.accounts {
			acc := &p.accounts[i]
			if acc.ID != preferredID {
				continue
			}
			if p.canServeLocked(acc, model, excluded, now, allowOverUsage) && !p.outrankedLocked(acc, model, excluded, mode) {
				p.noteRPMStartLocked(acc.ID)
				accCopy := *acc
				return &accCopy
			}
			break
		}
	}
	return p.nextAccountLocked(model, excluded, mode)
}

// nextAccountLocked is mode's pick, which must be a routing mode.
func (p *AccountPool) nextAccountLocked(model string, excluded map[string]bool, mode string) *config.Account {
	if len(p.accounts) == 0 {
		return nil
	}
	switch mode {
	case config.RoutingModePriority:
		return p.firstByPriorityLocked(model, excluded)
	case config.RoutingModeResetFirst:
		return p.firstByResetLocked(model, excluded)
	}

	return p.findNextAvailableLocked(model, excluded)
}

// findNextAvailableLocked is the weighted pick: the first slot of the rotation,
// from the cursor on, whose account can serve. The cursor moves past it.
func (p *AccountPool) findNextAvailableLocked(model string, excluded map[string]bool) *config.Account {
	//! The account just picked is not skipped when its slot comes up next. The cycle already
	//! spreads each account's slots as evenly as the weights allow; skipping the last account
	//! would hand its due slots to the others and pull every account towards an equal share.
	allowOverUsage := config.GetAllowOverUsage()
	now := time.Now()
	n := uint64(len(p.rotation))
	// failed holds the accounts that cannot serve this pick, so a heavy account's other slots are not checked again.
	failed := make(map[int]bool)

	for i := uint64(0); i < n; i++ {
		slot := (p.currentIndex + i) % n
		idx := p.rotation[slot]
		if failed[idx] {
			continue
		}
		acc := &p.accounts[idx]
		if !p.canServeLocked(acc, model, excluded, now, allowOverUsage) {
			failed[idx] = true
			continue
		}
		accCopy := *acc
		p.currentIndex = (slot + 1) % n
		p.noteRPMStartLocked(accCopy.ID)
		return &accCopy
	}
	return nil
}

func (p *AccountPool) canServeLocked(acc *config.Account, model string, excluded map[string]bool, now time.Time, allowOverUsage bool) bool {
	return p.eligibleLocked(acc, model, excluded, now, allowOverUsage) && !p.rpmLimitedLocked(acc.ID)
}

// eligibleLocked is canServeLocked without the per-account RPM limit.
func (p *AccountPool) eligibleLocked(acc *config.Account, model string, excluded map[string]bool, now time.Time, allowOverUsage bool) bool {
	if excluded != nil && excluded[acc.ID] {
		return false
	}
	if model != "" && !p.accountHasModel(acc.ID, model) {
		return false
	}
	if cooldown, ok := p.cooldowns[acc.ID]; ok && now.Before(cooldown) {
		return false
	}
	if tokenUnavailableForSelection(acc, now.Unix()) {
		return false
	}
	if isOverUsageLimit(*acc) && !isUpstreamOverageEnabled(*acc) && !allowOverUsage {
		return false
	}
	return true
}

func tokenUnavailableForSelection(acc *config.Account, nowUnix int64) bool {
	if acc == nil || acc.ExpiresAt == 0 {
		return false
	}
	if nowUnix <= acc.ExpiresAt-tokenRefreshSkewSeconds {
		return false
	}
	return acc.RefreshToken == ""
}

func (p *AccountPool) GetByID(id string) *config.Account {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			accCopy := p.accounts[i]
			return &accCopy
		}
	}
	return nil
}

func (p *AccountPool) RecordSuccess(id string) {
	p.mu.Lock()
	cleared := time.Now().Before(p.cooldowns[id])
	delete(p.cooldowns, id)
	delete(p.cooldownKinds, id)
	p.errorCounts[id] = 0
	p.mu.Unlock()
	if cleared {
		notifyCooldownChanged(id)
	}
	notifySuccess(id)
}

func (p *AccountPool) RecordError(id string, isQuotaError bool) int {
	return p.recordError(id, isQuotaError, 0)
}

func (p *AccountPool) RecordQuotaError(id string, retryAfter time.Duration) int {
	return p.recordError(id, true, retryAfter)
}

const (
	//! Kiro's throttle clears within a second or two, and a model only one account serves is
	//! offline for the whole wait, so the first rung is seconds, not a minute.
	throttleBaseCooldown = 5 * time.Second
	throttleMaxCooldown  = 10 * time.Minute
)

// RecordThrottleError cools an account after transient upstream throttling.
// Without a retry hint the cooldown starts at five seconds and doubles with every
// consecutive throttle, capped at ten minutes; a success resets it. A throttle
// that lands while the account is already cooling came from a request picked
// before the cooldown began, so it is the same throttle and does not climb.
func (p *AccountPool) RecordThrottleError(id string, retryAfter time.Duration) int {
	p.mu.Lock()
	if !time.Now().Before(p.cooldowns[id]) {
		p.errorCounts[id]++
	}
	count := max(p.errorCounts[id], 1)

	delay := retryAfter
	if delay <= 0 {
		delay = throttleBaseCooldown
		for i := 1; i < count && delay < throttleMaxCooldown; i++ {
			delay *= 2
		}
		delay = min(delay, throttleMaxCooldown)
	}
	//! Never shorten a longer cooldown, such as a quota cooldown already in force.
	until := time.Now().Add(delay)
	grew := until.After(p.cooldowns[id])
	if grew {
		p.setKindLocked(id, p.throttleKindLocked(id, retryAfter))
		p.cooldowns[id] = until
	}
	p.mu.Unlock()

	p.saveCooldownsInBackground()
	if grew {
		notifyCooldownChanged(id)
	}

	return count
}

// CooldownUntil reports when the account's current cooldown ends; zero means none.
func (p *AccountPool) CooldownUntil(id string) time.Time {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.cooldowns[id]
}

func (p *AccountPool) recordError(id string, isQuotaError bool, retryAfter time.Duration) int {
	p.mu.Lock()
	p.errorCounts[id]++
	count := p.errorCounts[id]

	changed := false
	if isQuotaError {
		until := p.calculateQuotaCooldown(id)
		if retryAfter > 0 {
			until = time.Now().Add(retryAfter)
		}
		if until.After(p.cooldowns[id]) {
			p.cooldowns[id] = until
			p.setKindLocked(id, CooldownQuota)
			changed = true
		}
	} else if count >= 3 {

		p.cooldowns[id] = time.Now().Add(time.Minute)
		p.setKindLocked(id, CooldownError)
		changed = true
	}
	p.mu.Unlock()

	p.saveCooldownsInBackground()
	if changed {
		notifyCooldownChanged(id)
	}

	return count
}

func (p *AccountPool) calculateQuotaCooldown(accountID string) time.Time {
	var resetDate string
	for _, acc := range p.accounts {
		if acc.ID == accountID {
			resetDate = acc.NextResetDate
			break
		}
	}

	if resetDate != "" {
		if t, err := time.Parse("2006-01-02", resetDate); err == nil {
			resetTime := t.Add(24 * time.Hour)
			if resetTime.After(time.Now()) {
				return resetTime
			}
		}
	}

	return time.Now().Add(24 * time.Hour)
}

func IsAuthFailure(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	lower := strings.ToLower(msg)

	//! Match standalone status codes only; request IDs like 401abc must not disable accounts.
	if hasStatusToken(msg, "401") || hasStatusToken(msg, "403") {
		return true
	}
	if strings.Contains(lower, "bad credentials") ||
		strings.Contains(lower, "invalid_grant") ||
		strings.Contains(lower, "invalid grant") ||
		strings.Contains(lower, "invalid_token") ||
		strings.Contains(lower, "invalid token") ||
		strings.Contains(lower, "token expired") ||
		strings.Contains(lower, "token has expired") ||
		strings.Contains(lower, "unauthorized") {
		return true
	}
	return false
}

func hasStatusToken(s, status string) bool {
	for {
		idx := strings.Index(s, status)
		if idx < 0 {
			return false
		}
		leftOK := idx == 0 || !isAlphaNumeric(s[idx-1])
		rightIdx := idx + len(status)
		rightOK := rightIdx >= len(s) || !isAlphaNumeric(s[rightIdx])
		if leftOK && rightOK {
			return true
		}
		s = s[idx+len(status):]
	}
}

func isAlphaNumeric(b byte) bool {
	return (b >= '0' && b <= '9') ||
		(b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z')
}

func IsSuspensionError(err error) bool {
	if err == nil {
		return false
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "temporarily_suspended") ||
		strings.Contains(lower, "temporarily suspended") ||
		strings.Contains(lower, "locked your account") ||
		strings.Contains(lower, "no available kiro profile")
}

func (p *AccountPool) DisableAccount(id, reason string) {
	if err := config.SetAccountBanStatus(id, "DISABLED", reason); err != nil {

		_ = err
	}
	p.mu.Lock()

	//! Keep a long cooldown as a safety net if Reload races with an in-flight request.
	p.cooldowns[id] = time.Now().Add(24 * time.Hour)
	p.setKindLocked(id, CooldownDisabled)
	p.mu.Unlock()
	_ = p.SaveCooldowns()
	p.Reload()
}

func (p *AccountPool) MarkOverLimit(id string) {
	p.mu.Lock()
	p.cooldowns[id] = time.Now().Add(time.Hour)
	p.setKindLocked(id, CooldownQuota)
	p.mu.Unlock()
	_ = p.SaveCooldowns()
	p.Reload()
	notifyCooldownChanged(id)
}

func (p *AccountPool) UpdateToken(id, accessToken, refreshToken string, expiresAt int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			p.accounts[i].AccessToken = accessToken
			if refreshToken != "" {
				p.accounts[i].RefreshToken = refreshToken
			}
			p.accounts[i].ExpiresAt = expiresAt
		}
	}
}

func (p *AccountPool) Count() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.totalAccounts > 0 {
		return p.totalAccounts
	}
	return len(p.accounts)
}

func (p *AccountPool) AvailableCount() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := time.Now()
	count := 0
	for _, acc := range p.accounts {
		if cooldown, ok := p.cooldowns[acc.ID]; ok && now.Before(cooldown) {
			continue
		}
		count++
	}
	return count
}

// RecordOutcome counts one finished client request against the account that
// served it: RequestCount always, ErrorCount when it failed. It is called once
// per final request, never per retry, so the account's numbers match the
// request log. An account out of rotation (disabled mid-request, over its
// limit) is counted on its persisted row instead of being dropped.
func (p *AccountPool) RecordOutcome(id string, success bool, tokens int, credits float64) {
	p.updateStats(id, func(acc *config.Account) {
		acc.RequestCount++
		if !success {
			acc.ErrorCount++
		}
		addUsage(acc, tokens, credits)
	})
	p.noteSpend(id, credits)
}

// AddUsage adds tokens and credits an account spent on part of a request that
// is counted against another account, such as an earlier round of a web search
// loop that failed over. RequestCount and ErrorCount stay as they are.
func (p *AccountPool) AddUsage(id string, tokens int, credits float64) {
	if tokens <= 0 && credits <= 0 {
		return
	}
	p.updateStats(id, func(acc *config.Account) { addUsage(acc, tokens, credits) })
	p.noteSpend(id, credits)
}

// updateStats applies apply to the account's counters, in rotation or, for an
// account out of rotation, on its persisted row, and saves them.
func (p *AccountPool) updateStats(id string, apply func(acc *config.Account)) {
	if id == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	var stats *config.Account
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			apply(&p.accounts[i])
			stats = &p.accounts[i]
			break
		}
	}
	if stats == nil {
		stored := findConfigAccount(id)
		if stored == nil {
			return
		}
		apply(stored)
		stats = stored
	}
	_ = config.UpdateAccountStats(id, stats.RequestCount, stats.ErrorCount, stats.TotalTokens, stats.TotalCredits, stats.LastUsed)
}

func addUsage(acc *config.Account, tokens int, credits float64) {
	acc.TotalTokens += max(tokens, 0)
	acc.TotalCredits += max(credits, 0)
	acc.LastUsed = time.Now().Unix()
}

func findConfigAccount(id string) *config.Account {
	for _, acc := range config.GetAccounts() {
		if acc.ID == id {
			return &acc
		}
	}
	return nil
}

func (p *AccountPool) GetAllAccounts() []config.Account {
	p.mu.RLock()
	defer p.mu.RUnlock()
	result := make([]config.Account, len(p.accounts))
	copy(result, p.accounts)
	return result
}

func isOverUsageLimit(acc config.Account) bool {
	return acc.UsageLimit > 0 && acc.UsageCurrent >= acc.UsageLimit
}

func isUpstreamOverageEnabled(acc config.Account) bool {
	return strings.EqualFold(acc.OverageStatus, "ENABLED")
}

// effectiveWeight is the share weight gives an account in the weighted cycle:
// below 1 counts as 1, and above MaxAccountWeight as MaxAccountWeight.
func effectiveWeight(weight int) int {
	//! The admin API refuses a weight over the cap, but a hand-edited config or an import can
	//! still hold one, and the cycle has a slot per unit of weight: uncapped, a weight of 1e10
	//! would exhaust memory on every reload, startup included.
	return min(max(weight, 1), config.MaxAccountWeight)
}
