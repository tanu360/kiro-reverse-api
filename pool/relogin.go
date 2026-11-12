package pool

// ClearCooldown drops the account's cooldown and error streak after its login was replaced:
// they describe the old credential. Unlike RecordSuccess it persists at once, so a restart
// cannot bring the cooldown back.
func (p *AccountPool) ClearCooldown(id string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	_, had := p.cooldowns[id]
	delete(p.cooldowns, id)
	delete(p.errorCounts, id)
	p.mu.Unlock()
	if !had {
		return
	}
	_ = p.SaveCooldowns()
	notifyCooldownChanged(id)
}
