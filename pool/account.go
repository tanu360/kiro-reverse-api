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
	errorCounts   map[string]int
	modelLists    map[string]map[string]bool
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
	for _, a := range enabled {
		if isOverUsageLimit(a) && !isUpstreamOverageEnabled(a) && !allowOverUsage {
			continue
		}
		w := effectiveWeight(a.Weight)
		for j := 0; j < w; j++ {
			weighted = append(weighted, a)
		}
	}
	p.accounts = weighted
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

func (p *AccountPool) GetNextForModel(model string) *config.Account {
	return p.GetNextForModelExcluding(model, nil)
}

func (p *AccountPool) GetNextForModelExcluding(model string, excluded map[string]bool) *config.Account {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.nextAccountLocked(model, excluded)
}

func (p *AccountPool) nextAccountLocked(model string, excluded map[string]bool) *config.Account {
	if len(p.accounts) == 0 {
		return nil
	}

	if acc := p.findNextAvailableLocked(model, excluded, true); acc != nil {
		return acc
	}
	if acc := p.findNextAvailableLocked(model, excluded, false); acc != nil {
		return acc
	}
	return p.findEarliestCooldownLocked(model, excluded)
}

func (p *AccountPool) findNextAvailableLocked(model string, excluded map[string]bool, avoidLast bool) *config.Account {
	allowOverUsage := config.GetAllowOverUsage()
	now := time.Now()
	nowUnix := now.Unix()
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
		if excluded != nil && excluded[acc.ID] {
			continue
		}
		if model != "" && !p.accountHasModel(acc.ID, model) {
			continue
		}
		if cooldown, ok := p.cooldowns[acc.ID]; ok && now.Before(cooldown) {
			continue
		}
		if acc.ExpiresAt > 0 && nowUnix > acc.ExpiresAt-tokenRefreshSkewSeconds {
			continue
		}
		if isOverUsageLimit(*acc) && !isUpstreamOverageEnabled(*acc) && !allowOverUsage {
			continue
		}
		p.currentIndex = (idx + 1) % uint64(n)
		p.lastSelected = acc.ID
		return acc
	}
	return nil
}

func (p *AccountPool) findEarliestCooldownLocked(model string, excluded map[string]bool) *config.Account {
	allowOverUsage := config.GetAllowOverUsage()
	nowUnix := time.Now().Unix()
	var best *config.Account
	var earliest time.Time
	seen := make(map[string]bool)
	for i := range p.accounts {
		acc := &p.accounts[i]
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true
		if excluded != nil && excluded[acc.ID] {
			continue
		}
		if model != "" && !p.accountHasModel(acc.ID, model) {
			continue
		}
		if acc.ExpiresAt > 0 && nowUnix > acc.ExpiresAt-tokenRefreshSkewSeconds {
			continue
		}
		if isOverUsageLimit(*acc) && !isUpstreamOverageEnabled(*acc) && !allowOverUsage {
			continue
		}
		if cooldown, ok := p.cooldowns[acc.ID]; ok {
			if best == nil || cooldown.Before(earliest) {
				best = acc
				earliest = cooldown
			}
		}
	}
	if best != nil {
		p.lastSelected = best.ID
	}
	return best
}

func (p *AccountPool) GetByID(id string) *config.Account {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			return &p.accounts[i]
		}
	}
	return nil
}

func (p *AccountPool) RecordSuccess(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.cooldowns, id)
	p.errorCounts[id] = 0
}

func (p *AccountPool) RecordError(id string, isQuotaError bool) int {
	p.mu.Lock()
	p.errorCounts[id]++
	count := p.errorCounts[id]

	if isQuotaError {
		p.cooldowns[id] = p.calculateQuotaCooldown(id)
	} else if count >= 3 {

		p.cooldowns[id] = time.Now().Add(time.Minute)
	}
	p.mu.Unlock()

	go func() {
		_ = p.SaveCooldowns()
	}()

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
		leftOK := idx == 0 || !isDigit(s[idx-1])
		rightIdx := idx + len(status)
		rightOK := rightIdx >= len(s) || !isDigit(s[rightIdx])
		if leftOK && rightOK {
			return true
		}
		s = s[idx+len(status):]
	}
}

func isDigit(b byte) bool {
	return b >= '0' && b <= '9'
}

func IsSuspensionError(err error) bool {
	if err == nil {
		return false
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "temporarily_suspended") ||
		strings.Contains(lower, "temporarily suspended") ||
		strings.Contains(lower, "no available kiro profile")
}

func (p *AccountPool) DisableAccount(id, reason string) {
	if err := config.SetAccountBanStatus(id, "DISABLED", reason); err != nil {

		_ = err
	}
	p.mu.Lock()

	//! Keep a long cooldown as a safety net if Reload races with an in-flight request.
	p.cooldowns[id] = time.Now().Add(24 * time.Hour)
	p.mu.Unlock()
	_ = p.SaveCooldowns()
	p.Reload()
}

func (p *AccountPool) MarkOverLimit(id string) {
	p.mu.Lock()
	p.cooldowns[id] = time.Now().Add(time.Hour)
	p.mu.Unlock()
	_ = p.SaveCooldowns()
	p.Reload()
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

func (p *AccountPool) UpdateStats(id string, tokens int, credits float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var updated bool
	var requestCount, errorCount, totalTokens int
	var totalCredits float64
	var lastUsed int64
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			if !updated {
				p.accounts[i].RequestCount++
				p.accounts[i].TotalTokens += tokens
				p.accounts[i].TotalCredits += credits
				p.accounts[i].LastUsed = time.Now().Unix()

				requestCount = p.accounts[i].RequestCount
				errorCount = p.accounts[i].ErrorCount
				totalTokens = p.accounts[i].TotalTokens
				totalCredits = p.accounts[i].TotalCredits
				lastUsed = p.accounts[i].LastUsed
				updated = true
				continue
			}
			p.accounts[i].RequestCount = requestCount
			p.accounts[i].ErrorCount = errorCount
			p.accounts[i].TotalTokens = totalTokens
			p.accounts[i].TotalCredits = totalCredits
			p.accounts[i].LastUsed = lastUsed
		}
	}
	if updated {
		_ = config.UpdateAccountStats(id, requestCount, errorCount, totalTokens, totalCredits, lastUsed)
	}
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
