package config

import "fmt"

// ReplaceAccountLogin swaps one stored account for the one fn builds from it, in whichever
// store holds the accounts. fn sees the stored row and every other row under the store's
// write lock, so a duplicate check it makes cannot race another write. An error from fn saves
// nothing. Unlike UpdateAccount, the credential fields are not preserved: replacing them is
// the point. The id never changes.
func ReplaceAccountLogin(id string, fn func(current Account, others []Account) (Account, error)) (saved Account, err error) {
	defer func() {
		if err == nil {
			notifyAccountsChanged(id)
		}
	}()
	if CredentialsLoaded() {
		credLock.Lock()
		defer credLock.Unlock()
		return replaceAccountLoginLocked(credentials, id, fn, saveCredentialsLocked)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	return replaceAccountLoginLocked(cfg.Accounts, id, fn, Save)
}

func replaceAccountLoginLocked(accounts []Account, id string, fn func(Account, []Account) (Account, error), save func() error) (Account, error) {
	index := -1
	others := make([]Account, 0, len(accounts))
	for i := range accounts {
		if accounts[i].ID == id {
			index = i
			continue
		}
		others = append(others, accounts[i])
	}
	if index < 0 {
		return Account{}, fmt.Errorf("account not found: %s", id)
	}
	previous := accounts[index]
	next, err := fn(previous, others)
	if err != nil {
		return Account{}, err
	}
	next.ID = id
	accounts[index] = next
	if err := save(); err != nil {
		accounts[index] = previous
		return Account{}, err
	}
	return next, nil
}

// SameKiroUser reports whether two accounts are one Kiro user by the duplicate rules: the same
// refresh token, Kiro API key, user id or email.
func SameKiroUser(a, b *Account) bool {
	return duplicateReason(a, b) != ""
}

// AbsorbLogin moves a fresh login onto the stored account id the way a repeat add does: the
// login's tokens replace the stored ones, and the operator's settings, notes and tags stay.
func AbsorbLogin(id string, incoming Account) (Account, error) {
	return ReplaceAccountLogin(id, func(current Account, _ []Account) (Account, error) {
		applyIncoming(&current, incoming)
		return current, nil
	})
}
