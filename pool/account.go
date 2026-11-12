package pool

import (
	"kiro-proxy/config"
	"strings"
	"sync"
	"time"
)

const tokenRefreshSkewSeconds int64 = 120

type AccountPool struct {
	mu            sync.RWMutex
	accounts      []config.Account
	totalAccounts int
	currentIndex  uint64
	lastSelected  string
	cooldowns     map[string]time.Time
	// cooldownKinds says what set each cooldown, so self-heal never clears a quota one.
	cooldownKinds map[string]CooldownKind
	errorCounts   map[string]int
	modelLists    map[string]map[string]bool
	// enabledIDs lists every enabled account, including over-limit ones Reload keeps out of rotation.
	enabledIDs []string
	// rpm holds recent starts per account for the optional RPM limit (rpm_limit.go).
	rpm rpmStarts
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
	var weighted []config.Account
	enabledIDs := make([]string, 0, len(enabled))
	for _, a := range enabled {
		enabledIDs = append(enabledIDs, a.ID)
		if isOverUsageLimit(a) && !isUpstreamOverageEnabled(a) && !allowOverUsage {
			continue
		}
		w := effectiveWeight(a.Weight)
		for j := 0; j < w; j++ {
			weighted = append(weighted, a)
		}
	}
	p.accounts = weighted
	p.enabledIDs = enabledIDs
	p.totalAccounts = len(enabled)
	if len(weighted) == 0 {
		p.currentIndex = 0
		p.lastSelected = ""
	} else if p.currentIndex >= uint64(len(weighted)) {
		p.currentIndex %= uint64(len(weighted))
	}
}

func (p *AccountPool) GetNext() *config.Account {
	return p.GetNextExcluding(nil)
}

func (p *AccountPool) GetNextExcluding(excluded map[string]bool) *config.Account {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.nextAccountLocked("", excluded)
}

func (p *AccountPool) SetModelList(accountID string, modelIDs []string) {
	set := make(map[string]bool, len(modelIDs))
	for _, id := range modelIDs {
		set[strings.ToLower(strings.TrimSpace(id))] = true
	}
	p.mu.Lock()
	p.modelLists[accountID] = set
	p.mu.Unlock()
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
	list, ok := p.modelLists[accountID]
	if !ok || len(list) == 0 {
		return true
	}
	return list[strings.ToLower(strings.TrimSpace(model))]
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
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.nextAccountLocked(model, excluded)
}

// GetPreferredForModelExcluding returns preferredID when that account can serve
// model right now, and the round-robin pick otherwise. A preferred hit leaves
// the rotation cursor alone, so sticky conversations do not skew where new
// conversations land.
func (p *AccountPool) GetPreferredForModelExcluding(preferredID, model string, excluded map[string]bool) *config.Account {
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
			if p.canServeLocked(acc, model, excluded, now, allowOverUsage) {
				p.noteRPMStartLocked(acc.ID)
				accCopy := *acc
				return &accCopy
			}
			break
		}
	}
	return p.nextAccountLocked(model, excluded)
}

func (p *AccountPool) nextAccountLocked(model string, excluded map[string]bool) *config.Account {
	if len(p.accounts) == 0 {
		return nil
	}
	if config.GetRoutingMode() == config.RoutingModePriority {
		return p.firstByPriorityLocked(model, excluded)
	}

	if acc := p.findNextAvailableLocked(model, excluded, true); acc != nil {
		return acc
	}
	if acc := p.findNextAvailableLocked(model, excluded, false); acc != nil {
		return acc
	}
	return nil
}

func (p *AccountPool) findNextAvailableLocked(model string, excluded map[string]bool, avoidLast bool) *config.Account {
	allowOverUsage := config.GetAllowOverUsage()
	now := time.Now()
	n := len(p.accounts)
	start := p.currentIndex
	seen := make(map[string]bool)

	for i := 0; i < n; i++ {
		idx := (start + uint64(i)) % uint64(n)
		acc := &p.accounts[idx]
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true

		if avoidLast && acc.ID == p.lastSelected {
			continue
		}
		if !p.canServeLocked(acc, model, excluded, now, allowOverUsage) {
			continue
		}
		accCopy := *acc
		p.currentIndex = (idx + 1) % uint64(n)
		p.lastSelected = accCopy.ID
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
	throttleBaseCooldown = time.Minute
	throttleMaxCooldown  = 10 * time.Minute
)

// RecordThrottleError cools an account after transient upstream throttling.
// Without a retry hint the cooldown starts at a minute and doubles with every
// consecutive failure, capped at ten minutes; a success resets it.
func (p *AccountPool) RecordThrottleError(id string, retryAfter time.Duration) int {
	p.mu.Lock()
	p.errorCounts[id]++
	count := p.errorCounts[id]

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

	go func() {
		_ = p.SaveCooldowns()
	}()
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

	go func() {
		_ = p.SaveCooldowns()
	}()
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

	seen := make(map[string]bool)
	for _, acc := range p.accounts {
		seen[acc.ID] = true
	}
	return len(seen)
}

func (p *AccountPool) AvailableCount() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := time.Now()
	count := 0
	seen := make(map[string]bool)
	for _, acc := range p.accounts {
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true
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
}

// AddUsage adds tokens and credits an account spent on part of a request that
// is counted against another account, such as an earlier round of a web search
// loop that failed over. RequestCount and ErrorCount stay as they are.
func (p *AccountPool) AddUsage(id string, tokens int, credits float64) {
	if tokens <= 0 && credits <= 0 {
		return
	}
	p.updateStats(id, func(acc *config.Account) { addUsage(acc, tokens, credits) })
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
		if p.accounts[i].ID != id {
			continue
		}
		if stats == nil {
			apply(&p.accounts[i])
			stats = &p.accounts[i]
			continue
		}
		//! Weighted accounts appear several times in rotation; every copy carries the same numbers.
		copyStats(&p.accounts[i], stats)
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

func copyStats(dst, src *config.Account) {
	dst.RequestCount = src.RequestCount
	dst.ErrorCount = src.ErrorCount
	dst.TotalTokens = src.TotalTokens
	dst.TotalCredits = src.TotalCredits
	dst.LastUsed = src.LastUsed
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

func effectiveWeight(weight int) int {
	if weight < 1 {
		return 1
	}
	return weight
}
