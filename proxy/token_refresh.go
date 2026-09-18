package proxy

import (
	"context"
	"fmt"
	"sync"
	"time"

	"kiro-proxy/auth"
	"kiro-proxy/config"
	"kiro-proxy/pool"
)

type accountRefreshLock struct {
	gate chan struct{}
	refs int
}

var refreshLocks = struct {
	sync.Mutex
	accounts map[string]*accountRefreshLock
}{accounts: make(map[string]*accountRefreshLock)}

func lockAccountRefresh(ctx context.Context, id string) (func(), error) {
	refreshLocks.Lock()
	entry := refreshLocks.accounts[id]
	if entry == nil {
		entry = &accountRefreshLock{gate: make(chan struct{}, 1)}
		refreshLocks.accounts[id] = entry
	}
	entry.refs++
	refreshLocks.Unlock()
	releaseRef := func() {
		refreshLocks.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(refreshLocks.accounts, id)
		}
		refreshLocks.Unlock()
	}
	select {
	case entry.gate <- struct{}{}:
		return func() { <-entry.gate; releaseRef() }, nil
	case <-ctx.Done():
		releaseRef()
		return nil, ctx.Err()
	}
}

func storedAccount(id string) *config.Account {
	for _, account := range config.GetAccounts() {
		if account.ID == id {
			return &account
		}
	}
	return nil
}

// Every stored-account refresh shares this lock, including admin and profile probes.
func refreshStoredAccount(ctx context.Context, account *config.Account, force bool) error {
	unlock, err := lockAccountRefresh(ctx, account.ID)
	if err != nil {
		return err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	latest := storedAccount(account.ID)
	if latest == nil {
		return fmt.Errorf("account %s no longer exists", account.ID)
	}
	rotated := latest.RefreshToken != account.RefreshToken || latest.AccessToken != account.AccessToken
	*account = *latest
	valid := account.ExpiresAt == 0 || time.Now().Unix() < account.ExpiresAt-tokenRefreshSkewSeconds
	if config.IsAPIKeyAccount(account) || ((!force || rotated) && valid) {
		return nil
	}
	access, refresh, expiry, arn, err := auth.RefreshTokenContext(ctx, account)
	if err != nil {
		return err
	}
	if err := config.UpdateAccountToken(account.ID, access, refresh, expiry); err != nil {
		return err
	}
	if arn != "" {
		if err := config.UpdateAccountProfileArn(account.ID, arn); err != nil {
			return err
		}
	}
	latest = storedAccount(account.ID)
	if latest == nil {
		return fmt.Errorf("account %s deleted during refresh", account.ID)
	}
	*account = *latest
	pool.GetPool().Reload()
	return nil
}
