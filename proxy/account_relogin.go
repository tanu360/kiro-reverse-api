package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"

	"github.com/google/uuid"
)

// Re-login runs any add-account flow against an existing account: the add endpoints take an
// optional reloginAccountId, and where a flow would append a new account it replaces the
// target's credentials instead. The id, nickname, weight, proxy, machine id, silent and manual
// disable state, stats and request history stay; the credentials, region, profile and
// auto-applied ban and cooldown state are the new login's.

const (
	reloginBindingTTL    = 30 * time.Minute
	reloginMaxBindings   = 128
	reloginPendingTTL    = 10 * time.Minute
	reloginMaxPending    = 32
	reloginVerifyTimeout = 30 * time.Second
)

var (
	errReloginTargetGone       = errors.New("Account not found")
	errReloginSingleCredential = errors.New("re-login takes exactly one credential")
)

// reloginMismatchError is a finished login that belongs to another user than the account.
type reloginMismatchError struct {
	current, incoming config.Account
}

func (e *reloginMismatchError) Error() string {
	return "the new sign-in belongs to a different user than this account"
}

// reloginBindings maps a browser or device-code sign-in session to the account it logs in
// again. The binding is made when the flow starts, so poll and complete stay unchanged and an
// unknown account is refused before any AWS call.
type reloginBindings struct {
	mu      sync.Mutex
	targets map[string]reloginBinding
}

type reloginBinding struct {
	accountID string
	expiresAt time.Time
}

var reloginSessions = &reloginBindings{targets: make(map[string]reloginBinding)}

func (b *reloginBindings) bind(sessionID, accountID string) {
	if sessionID == "" || accountID == "" {
		return
	}
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, binding := range b.targets {
		if !now.Before(binding.expiresAt) {
			delete(b.targets, id)
		}
	}
	if len(b.targets) >= reloginMaxBindings {
		oldestID, oldest := "", time.Time{}
		for id, binding := range b.targets {
			if oldestID == "" || binding.expiresAt.Before(oldest) {
				oldestID, oldest = id, binding.expiresAt
			}
		}
		delete(b.targets, oldestID)
	}
	b.targets[sessionID] = reloginBinding{accountID: accountID, expiresAt: now.Add(reloginBindingTTL)}
}

// target is the account a session logs in again, or "" for a plain add. It leaves the binding
// in place, so a completion that fails and is retried still lands on the same account.
func (b *reloginBindings) target(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	binding, ok := b.targets[sessionID]
	if !ok {
		return ""
	}
	if !time.Now().Before(binding.expiresAt) {
		delete(b.targets, sessionID)
		return ""
	}
	return binding.accountID
}

func (b *reloginBindings) forget(sessionID string) {
	b.mu.Lock()
	delete(b.targets, sessionID)
	b.mu.Unlock()
}

// reloginStash keeps a finished login whose user differs from the account's until the admin
// confirms or discards it. Device codes are one-shot and social refresh tokens rotate, so the
// login cannot simply be redone with a flag.
type reloginStash struct {
	mu      sync.Mutex
	entries map[string]reloginPendingEntry
}

type reloginPendingEntry struct {
	accountID string
	account   config.Account
	expiresAt time.Time
}

var reloginPending = &reloginStash{entries: make(map[string]reloginPendingEntry)}

func (s *reloginStash) stash(accountID string, account config.Account) string {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, entry := range s.entries {
		if !now.Before(entry.expiresAt) {
			delete(s.entries, id)
		}
	}
	if len(s.entries) >= reloginMaxPending {
		oldestID, oldest := "", time.Time{}
		for id, entry := range s.entries {
			if oldestID == "" || entry.expiresAt.Before(oldest) {
				oldestID, oldest = id, entry.expiresAt
			}
		}
		delete(s.entries, oldestID)
	}
	id := uuid.NewString()
	s.entries[id] = reloginPendingEntry{accountID: accountID, account: account, expiresAt: now.Add(reloginPendingTTL)}
	return id
}

// take hands out a stashed login once, and only for the account it was made for.
func (s *reloginStash) take(id, accountID string) (config.Account, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[id]
	if !ok || entry.accountID != accountID {
		return config.Account{}, false
	}
	delete(s.entries, id)
	if !time.Now().Before(entry.expiresAt) {
		return config.Account{}, false
	}
	return entry.account, true
}

func (s *reloginStash) drop(id, accountID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, ok := s.entries[id]; ok && entry.accountID == accountID {
		delete(s.entries, id)
	}
}

// reloginTargetOK writes 404 when the account to log in again does not exist. Flows call it
// before any upstream request.
func reloginTargetOK(w http.ResponseWriter, id string) bool {
	if findAccountByID(id) == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return false
	}
	return true
}

// isSyntheticAPIKeyEmail is the label NormalizeAPIKeyAccount gives a key without an email. It
// names the key, not a user, so it never decides an identity.
func isSyntheticAPIKeyEmail(email string) bool {
	return strings.HasPrefix(email, "api-key-") && !strings.Contains(email, "@")
}

func identityEmail(email string) string {
	email = strings.TrimSpace(email)
	if isSyntheticAPIKeyEmail(email) {
		return ""
	}
	return email
}

// reloginIdentity reports whether the incoming login is the account's user: the same user id
// (compared only within one id namespace, Entra or Kiro) or the same email. verified is false
// when the two sides share no comparable id; such a login counts as the same user, since the
// user lookup is best effort and a transient failure must not block a re-login.
func reloginIdentity(current, incoming config.Account) (match, verified bool) {
	curUser, inUser := strings.TrimSpace(current.UserId), strings.TrimSpace(incoming.UserId)
	usersComparable := curUser != "" && inUser != "" &&
		config.IsExternalIdpAccount(&current) == config.IsExternalIdpAccount(&incoming)
	curEmail, inEmail := identityEmail(current.Email), identityEmail(incoming.Email)
	emailsComparable := curEmail != "" && inEmail != ""
	if !usersComparable && !emailsComparable {
		return true, false
	}
	if usersComparable && curUser == inUser {
		return true, true
	}
	if emailsComparable && strings.EqualFold(curEmail, inEmail) {
		return true, true
	}
	return false, true
}

// reloginDuplicate applies the add path's uniqueness rules to every account but the target: an
// Entra user and a Kiro API key may each be added once.
func reloginDuplicate(incoming config.Account, others []config.Account) error {
	key := strings.TrimSpace(incoming.KiroApiKey)
	external := config.IsExternalIdpAccount(&incoming) && incoming.UserId != ""
	for i := range others {
		if key != "" && strings.TrimSpace(others[i].KiroApiKey) == key {
			return config.ErrDuplicateKiroAPIKey
		}
		if external && config.IsExternalIdpAccount(&others[i]) && others[i].UserId == incoming.UserId {
			return errMicrosoftAccountExists
		}
	}
	return nil
}

// loginFamily names the kind of sign-in an account uses. Imports and browser sign-ins spell
// the same kind differently (an IAM login has no provider, an Enterprise import says so).
func loginFamily(account config.Account) string {
	switch {
	case config.IsAPIKeyAccount(&account):
		return "apikey"
	case config.IsExternalIdpAccount(&account):
		return "microsoft"
	}
	method := strings.ToLower(strings.TrimSpace(account.AuthMethod))
	provider := strings.ToLower(strings.TrimSpace(account.Provider))
	switch {
	case method == "social" || provider == "google" || provider == "github":
		return "social:" + provider
	case provider == "builderid":
		return "builderid"
	}
	return "enterprise"
}

func sameLoginMethod(a, b config.Account) bool {
	return loginFamily(a) == loginFamily(b)
}

// mergeRelogin is the stored account with the incoming login's credentials. identityReplaced
// also drops the usage and plan snapshots, which describe the previous user; stats stay.
func mergeRelogin(current, incoming config.Account, identityReplaced bool) config.Account {
	merged := current

	merged.AccessToken = incoming.AccessToken
	merged.RefreshToken = incoming.RefreshToken
	merged.KiroApiKey = incoming.KiroApiKey
	merged.ClientID = incoming.ClientID
	merged.ClientSecret = incoming.ClientSecret
	merged.AuthMethod = incoming.AuthMethod
	if incoming.Provider != "" || !sameLoginMethod(current, incoming) {
		merged.Provider = incoming.Provider
	}
	merged.Region = incoming.Region
	merged.ExpiresAt = incoming.ExpiresAt
	merged.TokenEndpoint = incoming.TokenEndpoint
	merged.IssuerURL = incoming.IssuerURL
	merged.Scopes = incoming.Scopes

	//! A machine id derived from the old key (Kiro CLI parity) follows the new key; one the
	//! operator set stays.
	if current.KiroApiKey != "" && incoming.KiroApiKey != "" &&
		current.MachineId == config.MachineIdFromAPIKey(current.KiroApiKey) {
		merged.MachineId = config.MachineIdFromAPIKey(incoming.KiroApiKey)
	}

	switch {
	case incoming.StartUrl != "":
		merged.StartUrl = incoming.StartUrl
	case !sameLoginMethod(current, incoming):
		merged.StartUrl = ""
	}

	switch {
	case identityReplaced:
		merged.Email = incoming.Email
		merged.UserId = incoming.UserId
	default:
		//! A key's fingerprint label never replaces a real email.
		if incoming.Email != "" && (!isSyntheticAPIKeyEmail(incoming.Email) || current.Email == "" || isSyntheticAPIKeyEmail(current.Email)) {
			merged.Email = incoming.Email
		}
		if incoming.UserId != "" {
			merged.UserId = incoming.UserId
		}
	}

	keepPin := current.ProfileArnPinned && current.ProfileArn != "" && !identityReplaced &&
		sameLoginMethod(current, incoming) && !config.IsAPIKeyAccount(&incoming)
	if !keepPin {
		merged.ProfileArn = incoming.ProfileArn
		merged.ProfileArnPinned = false
	}
	if config.IsAPIKeyAccount(&merged) {
		merged.ProfileArn = ""
		merged.ProfileArnPinned = false
	}

	//! Only an automatic hold (a ban, a suspension, a pool disable) is lifted. A manual disable
	//! sets no ban status and stays, like Silent. Kiro re-bans after the async check if needed.
	if current.BanStatus != "" && current.BanStatus != "ACTIVE" {
		merged.Enabled = true
		merged.BanStatus = "ACTIVE"
		merged.BanReason = ""
		merged.BanTime = 0
	}

	if identityReplaced {
		merged.SubscriptionType = ""
		merged.SubscriptionTitle = ""
		merged.DaysRemaining = 0
		merged.UsageCurrent = 0
		merged.UsageLimit = 0
		merged.UsagePercent = 0
		merged.NextResetDate = ""
		merged.LastRefresh = 0
		merged.TrialUsageCurrent = 0
		merged.TrialUsageLimit = 0
		merged.TrialUsagePercent = 0
		merged.TrialStatus = ""
		merged.TrialExpiresAt = 0
		merged.OverageStatus = ""
		merged.OverageCapability = ""
		merged.OverageCap = 0
		merged.OverageRate = 0
		merged.CurrentOverages = 0
		merged.OverageCheckedAt = 0
	}
	return merged
}

type reloginOutcome struct {
	account          config.Account
	identityVerified bool
	identityReplaced bool
}

// saveRelogin replaces targetID's login with incoming. It holds the account's refresh lock, so a
// background refresh of the old login cannot write its tokens over the new ones afterwards. A
// different user is refused with *reloginMismatchError unless replaceIdentity is set.
func (h *Handler) saveRelogin(ctx context.Context, targetID string, incoming config.Account, replaceIdentity bool) (reloginOutcome, error) {
	unlock, err := lockAccountRefresh(ctx, targetID)
	if err != nil {
		return reloginOutcome{}, err
	}
	defer unlock()

	var before config.Account
	var outcome reloginOutcome
	found := false
	saved, err := config.ReplaceAccountLogin(targetID, func(current config.Account, others []config.Account) (config.Account, error) {
		found = true
		match, verified := reloginIdentity(current, incoming)
		if !match && !replaceIdentity {
			return config.Account{}, &reloginMismatchError{current: current, incoming: incoming}
		}
		if err := reloginDuplicate(incoming, others); err != nil {
			return config.Account{}, err
		}
		before = current
		outcome.identityVerified = verified
		outcome.identityReplaced = !match
		return mergeRelogin(current, incoming, !match), nil
	})
	if err != nil {
		if !found {
			return reloginOutcome{}, errReloginTargetGone
		}
		return reloginOutcome{}, err
	}
	outcome.account = saved

	if h.pool != nil {
		h.pool.ClearCooldown(targetID)
		h.pool.Reload()
	}
	forgetProfileLookups(&before)
	forgetProfileLookups(&saved)
	logger.Infof("[Relogin] %s (%s) replaced=%t", saved.Email, saved.ID, outcome.identityReplaced)
	go reloginVerify(h, saved)
	return outcome, nil
}

// saveReloginGuarded takes the Microsoft flows lock for an Entra login, as the add path does,
// so a concurrent add of the same Entra user cannot pass the duplicate check as well.
func (h *Handler) saveReloginGuarded(ctx context.Context, targetID string, incoming config.Account, replaceIdentity bool) (reloginOutcome, error) {
	if config.IsExternalIdpAccount(&incoming) {
		microsoftSSOFlows.mu.Lock()
		defer microsoftSSOFlows.mu.Unlock()
	}
	return h.saveRelogin(ctx, targetID, incoming, replaceIdentity)
}

// forgetProfileLookups drops the cached profile-lookup failures of one login, which belong to
// the credential being replaced.
func forgetProfileLookups(account *config.Account) {
	key := profileArnCooldownKey(account)
	if key == "" {
		return
	}
	prefix := key + "\x00"
	profileArnResolutionCooldowns.Range(func(k, _ any) bool {
		if s, ok := k.(string); ok && strings.HasPrefix(s, prefix) {
			profileArnResolutionCooldowns.Delete(k)
		}
		return true
	})
}

// reloginVerify checks the new login in the background: usage (which re-bans a still suspended
// account through the usual failure handling, and the admin pages hear it over SSE), then the
// model list. Tests replace it.
var reloginVerify = func(h *Handler, account config.Account) {
	ctx, cancel := context.WithTimeout(context.Background(), reloginVerifyTimeout)
	defer cancel()
	_, suspended, err := h.refreshAccountNow(ctx, &account)
	h.pool.Reload()
	if err != nil || suspended {
		if err != nil {
			logger.Warnf("[Relogin] Check after re-login failed for %s: %v", account.Email, err)
		}
		return
	}
	if err := h.fetchAndCacheAccountModels(&account); err != nil {
		logger.Warnf("[ModelsCache] Auto-refresh failed after re-login of %s: %v", account.Email, err)
	}
}

// writeRelogin saves a finished login into targetID and writes the flow's response: extra plus
// the success fields, or 409 relogin_identity_mismatch with the stashed login's pendingId. It
// reports whether the login was used up (saved or stashed).
func (h *Handler) writeRelogin(w http.ResponseWriter, r *http.Request, targetID string, incoming config.Account, extra map[string]interface{}) bool {
	outcome, err := h.saveReloginGuarded(r.Context(), targetID, incoming, false)
	return writeReloginResult(w, targetID, incoming, outcome, err, extra)
}

// writeReloginFlowsLocked is writeRelogin for a caller that already holds microsoftSSOFlows.mu.
func (h *Handler) writeReloginFlowsLocked(w http.ResponseWriter, r *http.Request, targetID string, incoming config.Account, extra map[string]interface{}) bool {
	outcome, err := h.saveRelogin(r.Context(), targetID, incoming, false)
	return writeReloginResult(w, targetID, incoming, outcome, err, extra)
}

func writeReloginResult(w http.ResponseWriter, targetID string, incoming config.Account, outcome reloginOutcome, err error, extra map[string]interface{}) bool {
	var mismatch *reloginMismatchError
	switch {
	case err == nil:
	case errors.As(err, &mismatch):
		pendingID := reloginPending.stash(targetID, incoming)
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":       false,
			"error":         err.Error(),
			"code":          codeReloginIdentityMismatch,
			"pendingId":     pendingID,
			"accountId":     targetID,
			"currentEmail":  identityEmail(mismatch.current.Email),
			"incomingEmail": identityEmail(mismatch.incoming.Email),
			"expiresIn":     int(reloginPendingTTL / time.Second),
		})
		return true
	case errors.Is(err, errReloginTargetGone):
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return false
	case errors.Is(err, errMicrosoftAccountExists):
		writeMicrosoftAddError(w, err)
		return false
	default:
		writeAdminErr(w, addAccountErrorStatus(err), err, "")
		return false
	}

	response := make(map[string]interface{}, len(extra)+5)
	for key, value := range extra {
		response[key] = value
	}
	response["success"] = true
	response["relogin"] = true
	response["identityVerified"] = outcome.identityVerified
	response["identityReplaced"] = outcome.identityReplaced
	response["account"] = map[string]interface{}{
		"id":    outcome.account.ID,
		"email": outcome.account.Email,
	}
	json.NewEncoder(w).Encode(response)
	return true
}

// importKiroAPIKeyAccountFor imports a Kiro API key as a new account, or into targetID's account
// when one is set, with the add path's key and region checks.
func (h *Handler) importKiroAPIKeyAccountFor(w http.ResponseWriter, r *http.Request, targetID string, account config.Account) {
	if targetID == "" {
		h.importKiroAPIKeyAccount(w, account)
		return
	}
	if err := config.NormalizeAPIKeyAccount(&account); err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}
	if !config.IsKiroServiceRegion(account.Region) {
		writeAdminErr(w, http.StatusBadRequest, config.ErrUnsupportedKiroAPIKeyRegion, "")
		return
	}
	h.writeRelogin(w, r, targetID, account, nil)
}

// reloginSingleCredential writes 400 when a re-login import carries more than one credential.
func reloginSingleCredential(w http.ResponseWriter, entries []string) bool {
	count := 0
	for _, entry := range entries {
		if strings.TrimSpace(entry) != "" {
			count++
		}
	}
	if count > 1 {
		writeAdminError(w, http.StatusBadRequest, codeReloginSingleCredential, errReloginSingleCredential.Error())
		return false
	}
	return true
}

// microsoftWarningFields is the warning part of a Microsoft completion response.
func microsoftWarningFields(response map[string]interface{}, warning microsoftWarning) map[string]interface{} {
	if warning.text != "" {
		response["warning"] = warning.text
		response["warningCode"] = warning.code
		if warning.detail != "" {
			response["warningDetail"] = warning.detail
		}
	}
	return response
}

func decodePendingRelogin(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req struct {
		PendingID string `json:"pendingId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return "", false
	}
	return strings.TrimSpace(req.PendingID), true
}

// apiConfirmRelogin applies a stashed login whose user differs from the account's: the admin
// chose "Replace identity". POST /accounts/{id}/relogin/confirm {pendingId}.
func (h *Handler) apiConfirmRelogin(w http.ResponseWriter, r *http.Request, id string) {
	pendingID, ok := decodePendingRelogin(w, r)
	if !ok {
		return
	}
	incoming, found := reloginPending.take(pendingID, id)
	if !found {
		writeAdminError(w, http.StatusNotFound, codeReloginPendingNotFound, "Re-login not found or expired")
		return
	}
	outcome, err := h.saveReloginGuarded(r.Context(), id, incoming, true)
	writeReloginResult(w, id, incoming, outcome, err, nil)
}

// apiDiscardRelogin drops a stashed login at once instead of letting it expire.
// POST /accounts/{id}/relogin/discard {pendingId}.
func (h *Handler) apiDiscardRelogin(w http.ResponseWriter, r *http.Request, id string) {
	pendingID, ok := decodePendingRelogin(w, r)
	if !ok {
		return
	}
	reloginPending.drop(pendingID, id)
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}
