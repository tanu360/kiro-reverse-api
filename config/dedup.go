package config

import (
	"errors"
	"strings"

	"kiro-proxy/logger"
)

// Why two stored accounts are one Kiro user, in the order the rules are tried.
const (
	DuplicateReasonRefreshToken = "refresh_token"
	DuplicateReasonAPIKey       = "api_key"
	DuplicateReasonUserID       = "user_id"
	DuplicateReasonEmail        = "email"
)

var duplicateReasonOrder = []string{
	DuplicateReasonRefreshToken,
	DuplicateReasonAPIKey,
	DuplicateReasonUserID,
	DuplicateReasonEmail,
}

// AuthFailureBanReason is the ban reason the proxy sets when Kiro rejects an
// account's token. A fresh login cures it, so an upsert lifts this ban only.
const AuthFailureBanReason = "Authentication failed - token invalid or expired"

var (
	// ErrAccountNotFound is a merge that names an account no longer stored.
	ErrAccountNotFound = errors.New("account not found")
	errNothingToMerge  = errors.New("no other account to merge")
)

// DuplicateGroup is a set of stored accounts that are one Kiro user. IDs keep
// the store's order; Reasons lists every rule that joined two of them.
type DuplicateGroup struct {
	IDs             []string
	Reasons         []string
	SuggestedKeepID string
}

// AccountCounters are the per-account usage numbers a merge carries over.
type AccountCounters struct {
	RequestCount int
	ErrorCount   int
	TotalTokens  int
	TotalCredits float64
	LastUsed     int64
}

func sameValue(a, b string) bool {
	a = strings.TrimSpace(a)
	return a != "" && a == strings.TrimSpace(b)
}

func sameFolded(a, b string) bool {
	a = strings.TrimSpace(a)
	return a != "" && strings.EqualFold(a, strings.TrimSpace(b))
}

// bothSetAndDiffer is true only when each side has a value and they differ.
func bothSetAndDiffer(a, b string) bool {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	return a != "" && b != "" && a != b
}

func folded(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// duplicateReason names the first rule by which a and b are one Kiro user, or
// "" when they are not. An empty value never matches.
func duplicateReason(a, b *Account) string {
	if sameValue(a.RefreshToken, b.RefreshToken) {
		return DuplicateReasonRefreshToken
	}
	if sameValue(a.KiroApiKey, b.KiroApiKey) {
		return DuplicateReasonAPIKey
	}
	//! A Kiro API key is its own credential: two different keys stay two accounts, even for one user.
	if IsAPIKeyAccount(a) || IsAPIKeyAccount(b) {
		return ""
	}
	//! An empty provider is unknown, not different: IAM SSO and SSO-token logins store none, Builder ID device login stores "BuilderId".
	if bothSetAndDiffer(folded(a.Provider), folded(b.Provider)) {
		return ""
	}
	if sameValue(a.UserId, b.UserId) {
		return DuplicateReasonUserID
	}
	if folded(a.AuthMethod) != folded(b.AuthMethod) || !sameFolded(a.Email, b.Email) {
		return ""
	}
	//! By email an empty provider is unknown for IdC logins only. A social login's provider is part of who it is: one email can be a Google and a Github user.
	if folded(a.AuthMethod) != "idc" && folded(a.Provider) != folded(b.Provider) {
		return ""
	}
	//! One email can name different users: two Entra tenants, two IdC organizations. A pinned ARN is an operator choice, not an identity.
	if !a.ProfileArnPinned && !b.ProfileArnPinned && bothSetAndDiffer(a.ProfileArn, b.ProfileArn) {
		return ""
	}
	if bothSetAndDiffer(a.StartUrl, b.StartUrl) {
		return ""
	}
	if IsExternalIdpAccount(a) {
		//! The usage refresh can replace an Entra user's token-derived id with Kiro's, so the tenant decides instead.
		if bothSetAndDiffer(strings.TrimRight(a.IssuerURL, "/"), strings.TrimRight(b.IssuerURL, "/")) {
			return ""
		}
	} else if bothSetAndDiffer(a.UserId, b.UserId) {
		return ""
	}
	return DuplicateReasonEmail
}

// FindDuplicateGroups groups the accounts that are one Kiro user. Groups are
// transitive (A and B share a token, B and C an email: one group), hold two or
// more accounts, and come in the order of their first account.
func FindDuplicateGroups(accounts []Account) []DuplicateGroup {
	n := len(accounts)
	parent := make([]int, n)
	for i := range parent {
		parent[i] = i
	}
	find := func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}

	type link struct {
		member int
		reason string
	}
	var links []link
	for i := 0; i < n; i++ {
		if accounts[i].ID == "" {
			continue
		}
		for j := i + 1; j < n; j++ {
			if accounts[j].ID == "" {
				continue
			}
			reason := duplicateReason(&accounts[i], &accounts[j])
			if reason == "" {
				continue
			}
			ri, rj := find(i), find(j)
			if ri != rj {
				//! The lower index stays the root, so a group sorts by its first account.
				if ri < rj {
					parent[rj] = ri
				} else {
					parent[ri] = rj
				}
			}
			links = append(links, link{member: i, reason: reason})
		}
	}
	if len(links) == 0 {
		return nil
	}

	members := make(map[int][]int)
	var roots []int
	for i := 0; i < n; i++ {
		root := find(i)
		if _, seen := members[root]; !seen {
			roots = append(roots, root)
		}
		members[root] = append(members[root], i)
	}
	reasons := make(map[int]map[string]bool)
	for _, l := range links {
		root := find(l.member)
		if reasons[root] == nil {
			reasons[root] = make(map[string]bool)
		}
		reasons[root][l.reason] = true
	}

	var groups []DuplicateGroup
	for _, root := range roots {
		idx := members[root]
		if len(idx) < 2 {
			continue
		}
		group := DuplicateGroup{IDs: make([]string, 0, len(idx))}
		rows := make([]Account, 0, len(idx))
		for _, i := range idx {
			group.IDs = append(group.IDs, accounts[i].ID)
			rows = append(rows, accounts[i])
		}
		for _, reason := range duplicateReasonOrder {
			if reasons[root][reason] {
				group.Reasons = append(group.Reasons, reason)
			}
		}
		group.SuggestedKeepID = SuggestKeeper(rows)
		groups = append(groups, group)
	}
	return groups
}

// IsHealthyAccount is an account the pool can route to: enabled, not silenced
// or banned, and holding a token or key.
func IsHealthyAccount(a *Account) bool {
	if a == nil || !a.Enabled || a.Silent {
		return false
	}
	if a.BanStatus != "" && a.BanStatus != "ACTIVE" {
		return false
	}
	return strings.TrimSpace(a.AccessToken) != "" ||
		strings.TrimSpace(a.RefreshToken) != "" ||
		strings.TrimSpace(a.KiroApiKey) != ""
}

// SuggestKeeper picks the account a merge keeps: a healthy one first, then the
// latest usage refresh, then the latest token expiry, then the first listed.
func SuggestKeeper(group []Account) string {
	best := -1
	for i := range group {
		if best < 0 || betterKeeper(&group[i], &group[best]) {
			best = i
		}
	}
	if best < 0 {
		return ""
	}
	return group[best].ID
}

func betterKeeper(a, b *Account) bool {
	if ha, hb := IsHealthyAccount(a), IsHealthyAccount(b); ha != hb {
		return ha
	}
	if a.LastRefresh != b.LastRefresh {
		return a.LastRefresh > b.LastRefresh
	}
	return a.ExpiresAt > b.ExpiresAt
}

// UpsertAccount saves a new login or import. When it is a stored account's
// Kiro user, that account takes the new credentials and keeps its ID and
// operator settings (updated is true); otherwise the account is added. A Kiro
// API key that is already stored is refused with ErrDuplicateKiroAPIKey: the
// key never changes, so there is nothing to update. The exception is the same
// key and region with notes or tags, as an export imported back carries them:
// they join the stored account's, with a missing nickname (updated is true).
func UpsertAccount(account Account) (stored Account, updated bool, err error) {
	normalizeAccountMetadata(&account)
	if IsAPIKeyAccount(&account) {
		if err := NormalizeAPIKeyAccount(&account); err != nil {
			return Account{}, false, err
		}
		if !IsKiroServiceRegion(account.Region) {
			return Account{}, false, ErrUnsupportedKiroAPIKeyRegion
		}
	}
	defer func() {
		if err == nil {
			notifyAccountsChanged(stored.ID)
		}
	}()

	if CredentialsLoaded() {
		return upsertCredential(account)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	next, stored, updated, err := upsertInto(cfg.Accounts, account)
	if err != nil {
		return Account{}, false, err
	}
	previous := cfg.Accounts
	cfg.Accounts = next
	if err := Save(); err != nil {
		cfg.Accounts = previous
		return Account{}, false, err
	}
	return stored, updated, nil
}

func upsertCredential(account Account) (Account, bool, error) {
	credLock.Lock()
	defer credLock.Unlock()
	next, stored, updated, err := upsertInto(credentials, account)
	if err != nil {
		return Account{}, false, err
	}
	previous, previousLoaded := credentials, credLoaded
	credentials = next
	credLoaded = true
	if err := setSetting(credentialsLoadedKey, "1"); err != nil {
		credentials, credLoaded = previous, previousLoaded
		return Account{}, false, err
	}
	if err := saveCredentialsLocked(); err != nil {
		credentials, credLoaded = previous, previousLoaded
		return Account{}, false, err
	}
	return stored, updated, nil
}

// upsertInto returns a new slice, so a failed save leaves the stored list as it was.
func upsertInto(list []Account, incoming Account) ([]Account, Account, bool, error) {
	target := -1
	var best Account
	for i := range list {
		reason := duplicateReason(&list[i], &incoming)
		if reason == "" {
			continue
		}
		if IsAPIKeyAccount(&incoming) || IsAPIKeyAccount(&list[i]) {
			if reason == DuplicateReasonAPIKey && hasAccountMetadata(incoming) &&
				strings.EqualFold(strings.TrimSpace(list[i].Region), strings.TrimSpace(incoming.Region)) {
				//! An export imported back carries the key with notes or tags: nothing to replace, but they join.
				next := append([]Account(nil), list...)
				absorbIncomingMetadata(&next[i], incoming)
				fillIfEmpty(&next[i].Nickname, incoming.Nickname)
				return next, next[i], true, nil
			}
			return nil, Account{}, false, ErrDuplicateKiroAPIKey
		}
		//! With copies already stored, the login lands on the copy a merge would keep, ranked as it will be once updated.
		candidate := list[i]
		applyIncoming(&candidate, incoming)
		if target < 0 || betterKeeper(&candidate, &best) {
			target, best = i, candidate
		}
	}
	if target >= 0 {
		next := append([]Account(nil), list...)
		next[target] = best
		return next, best, true, nil
	}
	next := make([]Account, 0, len(list)+1)
	next = append(append(next, list...), incoming)
	return next, incoming, false, nil
}

// IsAuthFailureBan is an account the proxy banned because Kiro rejected its
// token, and that the operator has not silenced.
func IsAuthFailureBan(a *Account) bool {
	return a != nil && !a.Silent && a.BanStatus == "BANNED" && a.BanReason == AuthFailureBanReason
}

func setIfPresent(dst *string, value string) {
	if strings.TrimSpace(value) != "" {
		*dst = value
	}
}

func fillIfEmpty(dst *string, value string) {
	if strings.TrimSpace(*dst) == "" && strings.TrimSpace(value) != "" {
		*dst = value
	}
}

// applyIncoming moves a fresh login onto the stored account. The login is the
// newest proof of the credential, so its token set replaces the old one; the
// ID, machine ID, weight, proxy, enabled and ban state, counters and a pinned
// profile stay the operator's, and so do notes and tags, which only gain the
// login's. The one exception is a ban for a rejected token, which a fresh
// token cures.
func applyIncoming(dst *Account, src Account) {
	freshToken := strings.TrimSpace(src.AccessToken) != "" || strings.TrimSpace(src.RefreshToken) != ""
	if freshToken {
		dst.AccessToken = src.AccessToken
		dst.ExpiresAt = src.ExpiresAt
	}
	//! A re-login is how users fix a dead token; an operator's disable, a silence and a suspension stay.
	if freshToken && IsAuthFailureBan(dst) {
		dst.Enabled = true
		dst.BanStatus = "ACTIVE"
		dst.BanReason = ""
		dst.BanTime = 0
	}
	setIfPresent(&dst.RefreshToken, src.RefreshToken)
	if strings.TrimSpace(src.ClientID) != "" {
		//! The secret belongs to its client registration, so the pair moves together (Entra has no secret).
		dst.ClientID = src.ClientID
		dst.ClientSecret = src.ClientSecret
	}
	setIfPresent(&dst.AuthMethod, src.AuthMethod)
	setIfPresent(&dst.Region, src.Region)
	setIfPresent(&dst.StartUrl, src.StartUrl)
	setIfPresent(&dst.TokenEndpoint, src.TokenEndpoint)
	setIfPresent(&dst.IssuerURL, src.IssuerURL)
	setIfPresent(&dst.Scopes, src.Scopes)
	setIfPresent(&dst.Email, src.Email)
	if !dst.ProfileArnPinned {
		setIfPresent(&dst.ProfileArn, src.ProfileArn)
	}
	fillIfEmpty(&dst.UserId, src.UserId)
	fillIfEmpty(&dst.Provider, src.Provider)
	fillIfEmpty(&dst.Nickname, src.Nickname)
	absorbIncomingMetadata(dst, src)
}

// MergeAccounts keeps keepID and deletes removeIDs in one save. The kept
// account takes the freshest token of a removed account with its own sign-in
// method, any identity field or own proxy it lacks, and the given counters.
// Client API keys bound to a removed account are bound to the kept one instead.
// It returns ErrAccountNotFound when any ID is no longer stored, and changes
// nothing then.
func MergeAccounts(keepID string, removeIDs []string, counters AccountCounters) (kept Account, err error) {
	defer func() {
		if err == nil {
			notifyAccountsChanged(keepID)
			for _, id := range removeIDs {
				notifyAccountsChanged(id)
			}
		}
	}()

	if CredentialsLoaded() {
		kept, err := mergeCredentials(keepID, removeIDs, counters)
		if err != nil {
			return Account{}, err
		}
		//! The accounts are merged already; a key left on a removed id only stops matching.
		if err := RepointApiKeyAccounts(keepID, removeIDs); err != nil {
			logger.Warnf("[Accounts] Merged duplicates into %s, but could not move the API keys bound to them: %v", keepID, err)
		}
		return kept, nil
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	next, kept, err := mergeInto(cfg.Accounts, keepID, removeIDs, counters)
	if err != nil {
		return Account{}, err
	}
	previous := cfg.Accounts
	cfg.Accounts = next
	previousKeys := repointApiKeyAccountsLocked(keepID, removeIDs)
	if err := Save(); err != nil {
		cfg.Accounts = previous
		restoreApiKeyAccountsLocked(previousKeys)
		return Account{}, err
	}
	return kept, nil
}

// mergeCredentials is MergeAccounts for the credentials store.
func mergeCredentials(keepID string, removeIDs []string, counters AccountCounters) (Account, error) {
	credLock.Lock()
	defer credLock.Unlock()
	next, kept, err := mergeInto(credentials, keepID, removeIDs, counters)
	if err != nil {
		return Account{}, err
	}
	previous := credentials
	credentials = next
	if err := saveCredentialsLocked(); err != nil {
		credentials = previous
		return Account{}, err
	}
	return kept, nil
}

func mergeInto(list []Account, keepID string, removeIDs []string, counters AccountCounters) ([]Account, Account, error) {
	remove := make(map[string]bool, len(removeIDs))
	for _, id := range removeIDs {
		if id != "" && id != keepID {
			remove[id] = true
		}
	}
	if keepID == "" || len(remove) == 0 {
		return nil, Account{}, errNothingToMerge
	}

	keepIdx := -1
	found := make(map[string]bool, len(remove))
	var donors []Account
	for i := range list {
		switch id := list[i].ID; {
		case id == keepID && keepIdx < 0:
			keepIdx = i
		case remove[id]:
			found[id] = true
			donors = append(donors, list[i])
		}
	}
	if keepIdx < 0 || len(found) != len(remove) {
		return nil, Account{}, ErrAccountNotFound
	}

	keeper := list[keepIdx]
	absorbDonors(&keeper, donors)
	keeper.RequestCount = counters.RequestCount
	keeper.ErrorCount = counters.ErrorCount
	keeper.TotalTokens = counters.TotalTokens
	keeper.TotalCredits = counters.TotalCredits
	keeper.LastUsed = counters.LastUsed

	next := make([]Account, 0, len(list)-len(donors))
	for i := range list {
		switch {
		case i == keepIdx:
			next = append(next, keeper)
		case remove[list[i].ID]:
		default:
			next = append(next, list[i])
		}
	}
	return next, keeper, nil
}

func absorbDonors(keeper *Account, donors []Account) {
	//! Social refresh tokens rotate, so an older copy may hold a dead token; never move one across sign-in methods.
	method := folded(keeper.AuthMethod)
	var freshest *Account
	for i := range donors {
		donor := &donors[i]
		if folded(donor.AuthMethod) != method {
			continue
		}
		if strings.TrimSpace(donor.RefreshToken) == "" && strings.TrimSpace(donor.AccessToken) == "" {
			continue
		}
		if freshest == nil || donor.ExpiresAt > freshest.ExpiresAt {
			freshest = donor
		}
	}
	if freshest != nil && freshest.ExpiresAt > keeper.ExpiresAt {
		keeper.AccessToken = freshest.AccessToken
		keeper.RefreshToken = freshest.RefreshToken
		keeper.ExpiresAt = freshest.ExpiresAt
		keeper.ClientID = freshest.ClientID
		keeper.ClientSecret = freshest.ClientSecret
		setIfPresent(&keeper.Region, freshest.Region)
		setIfPresent(&keeper.StartUrl, freshest.StartUrl)
		setIfPresent(&keeper.TokenEndpoint, freshest.TokenEndpoint)
		setIfPresent(&keeper.IssuerURL, freshest.IssuerURL)
		setIfPresent(&keeper.Scopes, freshest.Scopes)
	}
	for _, donor := range donors {
		fillIfEmpty(&keeper.Email, donor.Email)
		fillIfEmpty(&keeper.UserId, donor.UserId)
		fillIfEmpty(&keeper.Nickname, donor.Nickname)
		fillIfEmpty(&keeper.Provider, donor.Provider)
		//! A copy may be reachable only through its own proxy; the merge must not move it to the pool or direct.
		fillIfEmpty(&keeper.ProxyURL, donor.ProxyURL)
		if !keeper.ProfileArnPinned {
			fillIfEmpty(&keeper.ProfileArn, donor.ProfileArn)
		}
		absorbDonorMetadata(keeper, donor)
	}
}
