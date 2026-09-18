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

	"kiro-proxy/auth"
	"kiro-proxy/config"
	"kiro-proxy/logger"

	"github.com/google/uuid"
)

const (
	microsoftSelectionTTL     = 10 * time.Minute
	microsoftMaxSelections    = 64
	microsoftCanceledTTL      = 10 * time.Minute
	microsoftMaxCanceled      = 128
	microsoftDiscoveryTimeout = 30 * time.Second
)

var (
	errMicrosoftSSOCanceled   = errors.New("Microsoft SSO login was canceled")
	errMicrosoftAccountExists = errors.New("this Microsoft account is already added")
)

// microsoftFlows holds what lives between the last SSO callback and the saved
// account: in-flight profile discoveries, profile choices waiting on the
// operator, and tombstones for canceled sessions. One mutex covers all three,
// and it is held across the final "not canceled?" check and AddAccount, so a
// cancel can never lose the race against a save.
type microsoftFlows struct {
	mu          sync.Mutex
	discoveries map[string]context.CancelFunc
	selections  map[string]*microsoftSelection
	canceled    map[string]time.Time
}

type microsoftSelection struct {
	sessionID string
	account   config.Account
	profiles  []KiroProfile
	expiresAt time.Time
}

var microsoftSSOFlows = newMicrosoftFlows()

func newMicrosoftFlows() *microsoftFlows {
	return &microsoftFlows{
		discoveries: make(map[string]context.CancelFunc),
		selections:  make(map[string]*microsoftSelection),
		canceled:    make(map[string]time.Time),
	}
}

// beginDiscovery refuses a canceled session and a second concurrent
// completion of the same session.
func (f *microsoftFlows) beginDiscovery(parent context.Context, sessionID string) (context.Context, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.canceledLocked(sessionID, time.Now()) || f.discoveries[sessionID] != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(parent, microsoftDiscoveryTimeout)
	f.discoveries[sessionID] = cancel
	return ctx, true
}

func (f *microsoftFlows) endDiscovery(sessionID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if cancel := f.discoveries[sessionID]; cancel != nil {
		cancel()
		delete(f.discoveries, sessionID)
	}
}

func (f *microsoftFlows) canceledLocked(sessionID string, now time.Time) bool {
	expiry, ok := f.canceled[sessionID]
	return ok && now.Before(expiry)
}

func (f *microsoftFlows) cancel(sessionID, selectionID string) {
	now := time.Now()
	f.mu.Lock()
	defer f.mu.Unlock()
	if sel := f.selections[selectionID]; sel != nil && sessionID == "" {
		sessionID = sel.sessionID
	}
	delete(f.selections, selectionID)
	if sessionID == "" {
		return
	}
	for id, sel := range f.selections {
		if sel.sessionID == sessionID {
			delete(f.selections, id)
		}
	}
	if cancel := f.discoveries[sessionID]; cancel != nil {
		cancel()
	}
	for id, expiry := range f.canceled {
		if !now.Before(expiry) {
			delete(f.canceled, id)
		}
	}
	if len(f.canceled) >= microsoftMaxCanceled {
		oldestID, oldest := "", time.Time{}
		for id, expiry := range f.canceled {
			if oldestID == "" || expiry.Before(oldest) {
				oldestID, oldest = id, expiry
			}
		}
		delete(f.canceled, oldestID)
	}
	f.canceled[sessionID] = now.Add(microsoftCanceledTTL)
	auth.CancelMicrosoftSSOLogin(sessionID)
}

func (f *microsoftFlows) storeSelectionLocked(sessionID string, account config.Account, profiles []KiroProfile, now time.Time) (string, error) {
	for id, sel := range f.selections {
		if !now.Before(sel.expiresAt) {
			delete(f.selections, id)
		}
	}
	if len(f.selections) >= microsoftMaxSelections {
		return "", errors.New("too many pending Microsoft profile selections; cancel one and try again")
	}
	id := uuid.NewString()
	f.selections[id] = &microsoftSelection{
		sessionID: sessionID,
		account:   account,
		profiles:  append([]KiroProfile(nil), profiles...),
		expiresAt: now.Add(microsoftSelectionTTL),
	}
	return id, nil
}

// addAccountLocked saves one finished login unless its session was canceled.
func (f *microsoftFlows) addAccountLocked(sessionID string, account config.Account) error {
	if f.canceledLocked(sessionID, time.Now()) {
		return errMicrosoftSSOCanceled
	}
	//! The Entra object ID is stable across logins; a second copy would double-spend one quota.
	if account.UserId != "" {
		for _, existing := range config.GetAccounts() {
			if config.IsExternalIdpAccount(&existing) && existing.UserId == account.UserId {
				return errMicrosoftAccountExists
			}
		}
	}
	return config.AddAccount(account)
}

func writeMicrosoftError(w http.ResponseWriter, status int, err error) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func writeMicrosoftAddError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errMicrosoftSSOCanceled), errors.Is(err, errMicrosoftAccountExists):
		writeMicrosoftError(w, http.StatusConflict, err)
	default:
		writeMicrosoftError(w, http.StatusInternalServerError, err)
	}
}

func (h *Handler) writeMicrosoftAdded(w http.ResponseWriter, account config.Account, warning string) {
	h.pool.Reload()
	if warning != "" {
		logger.Warnf("[MicrosoftSSO] %s: %s", account.Email, warning)
	} else {
		logger.Infof("[MicrosoftSSO] Added %s (region %s)", account.Email, account.Region)
	}
	response := map[string]interface{}{
		"success": true,
		"stage":   "complete",
		"account": map[string]interface{}{"id": account.ID, "email": account.Email},
	}
	if warning != "" {
		response["warning"] = warning
	}
	json.NewEncoder(w).Encode(response)
}

func (h *Handler) apiStartMicrosoftSSO(w http.ResponseWriter, _ *http.Request) {
	sessionID, authorizeURL, expiresIn, err := auth.StartMicrosoftSSOLogin()
	if err != nil {
		writeMicrosoftError(w, http.StatusInternalServerError, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sessionId":    sessionID,
		"authorizeUrl": authorizeURL,
		"expiresIn":    expiresIn,
		"stage":        "kiro",
	})
}

// apiCompleteMicrosoftSSO takes one pasted callback URL. The Kiro portal
// callback yields the Microsoft authorize URL; the Microsoft callback yields
// the credential, which is saved once its Kiro profile is known.
func (h *Handler) apiCompleteMicrosoftSSO(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID   string `json:"sessionId"`
		CallbackURL string `json:"callbackUrl"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeMicrosoftError(w, http.StatusBadRequest, errors.New("Invalid JSON"))
		return
	}
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" || strings.TrimSpace(req.CallbackURL) == "" {
		writeMicrosoftError(w, http.StatusBadRequest, errors.New("sessionId and callbackUrl are required"))
		return
	}

	progress, err := auth.ContinueMicrosoftSSOLogin(sessionID, req.CallbackURL)
	if err != nil {
		writeMicrosoftError(w, http.StatusBadRequest, err)
		return
	}
	if progress.AuthorizationURL != "" {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":      true,
			"stage":        "microsoft",
			"authorizeUrl": progress.AuthorizationURL,
		})
		return
	}
	if progress.Result == nil {
		writeMicrosoftError(w, http.StatusInternalServerError, errors.New("Microsoft SSO returned no credential"))
		return
	}

	result := progress.Result
	account := config.Account{
		ID:            auth.GenerateAccountID(),
		Email:         result.Email,
		UserId:        result.UserID,
		AccessToken:   result.AccessToken,
		RefreshToken:  result.RefreshToken,
		ClientID:      result.ClientID,
		AuthMethod:    auth.MicrosoftSSOAuthMethod,
		Provider:      auth.MicrosoftSSOProvider,
		Region:        "us-east-1",
		ExpiresAt:     result.ExpiresAt,
		Enabled:       true,
		MachineId:     config.GenerateMachineId(),
		TokenEndpoint: result.TokenEndpoint,
		IssuerURL:     result.IssuerURL,
		Scopes:        result.Scopes,
	}

	flows := microsoftSSOFlows
	ctx, ok := flows.beginDiscovery(r.Context(), sessionID)
	if !ok {
		writeMicrosoftError(w, http.StatusConflict, errMicrosoftSSOCanceled)
		return
	}
	profiles, profileErr := DiscoverKiroProfiles(ctx, &account)
	flows.endDiscovery(sessionID)
	if r.Context().Err() != nil {
		return
	}

	flows.mu.Lock()
	defer flows.mu.Unlock()
	if flows.canceledLocked(sessionID, time.Now()) {
		writeMicrosoftError(w, http.StatusConflict, errMicrosoftSSOCanceled)
		return
	}
	if len(profiles) > 1 {
		selectionID, err := flows.storeSelectionLocked(sessionID, account, profiles, time.Now())
		if err != nil {
			writeMicrosoftError(w, http.StatusServiceUnavailable, err)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":     true,
			"stage":       "profile",
			"selectionId": selectionID,
			"profiles":    profiles,
		})
		return
	}
	warning := ""
	if len(profiles) == 1 {
		account.ProfileArn = profiles[0].ARN
	} else {
		//! The credential is good; request-time resolution retries the profile, so keep the login.
		warning = "The account was added, but its Kiro profile could not be resolved yet"
		if profileErr != nil {
			warning += ": " + profileErr.Error()
		}
	}
	if err := flows.addAccountLocked(sessionID, account); err != nil {
		writeMicrosoftAddError(w, err)
		return
	}
	h.writeMicrosoftAdded(w, account, warning)
}

func (h *Handler) apiSelectMicrosoftSSOProfile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SelectionID string `json:"selectionId"`
		ProfileARN  string `json:"profileArn"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeMicrosoftError(w, http.StatusBadRequest, errors.New("Invalid JSON"))
		return
	}
	selectionID := strings.TrimSpace(req.SelectionID)
	profileARN := strings.TrimSpace(req.ProfileARN)

	flows := microsoftSSOFlows
	flows.mu.Lock()
	defer flows.mu.Unlock()
	sel := flows.selections[selectionID]
	if sel == nil || !time.Now().Before(sel.expiresAt) {
		delete(flows.selections, selectionID)
		writeMicrosoftError(w, http.StatusBadRequest, errors.New("Microsoft profile selection not found or expired"))
		return
	}
	//! Only an ARN Kiro listed for this token may be pinned; the client cannot name an arbitrary one.
	offered := false
	for _, profile := range sel.profiles {
		if profile.ARN == profileARN {
			offered = true
			break
		}
	}
	if !offered {
		writeMicrosoftError(w, http.StatusBadRequest, errors.New("Selected Kiro profile was not offered for this login"))
		return
	}

	account := sel.account
	account.ProfileArn = profileARN
	if err := flows.addAccountLocked(sel.sessionID, account); err != nil {
		if errors.Is(err, errMicrosoftSSOCanceled) {
			delete(flows.selections, selectionID)
		}
		writeMicrosoftAddError(w, err)
		return
	}
	delete(flows.selections, selectionID)
	h.writeMicrosoftAdded(w, account, "")
}

func (h *Handler) apiCancelMicrosoftSSO(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID   string `json:"sessionId"`
		SelectionID string `json:"selectionId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		writeMicrosoftError(w, http.StatusBadRequest, errors.New("Invalid JSON"))
		return
	}
	microsoftSSOFlows.cancel(strings.TrimSpace(req.SessionID), strings.TrimSpace(req.SelectionID))
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

var microsoftImportAliases = map[string]bool{
	"external_idp": true, "external-idp": true, "external": true,
	"microsoft": true, "m365": true, "office365": true,
	"azure": true, "azuread": true, "azure-ad": true, "azure_ad": true,
	"entra": true, "entra-id": true,
}

// isMicrosoftImport reports whether an imported credential belongs to Entra.
// An explicit method or provider decides it. With neither set, Entra-only
// fields decide it: a tenant endpoint, or one that Kiro Account Manager's
// userId or the access token's issuer lets us rebuild.
func isMicrosoftImport(method, provider, tokenEndpoint, issuerURL, userID, clientID, accessToken string) bool {
	method = strings.ToLower(strings.TrimSpace(method))
	provider = strings.ToLower(strings.TrimSpace(provider))
	if microsoftImportAliases[method] || microsoftImportAliases[provider] {
		return true
	}
	if method != "" || provider != "" {
		return false
	}
	if strings.TrimSpace(tokenEndpoint) != "" || strings.TrimSpace(issuerURL) != "" {
		return true
	}
	derived, _, _ := auth.DeriveExternalIdpEndpoints(userID, clientID, accessToken)
	return derived != ""
}

// completeMicrosoftImport fills the token endpoint, issuer and scopes an
// import left out, then validates the set before any refresh token is sent.
func completeMicrosoftImport(account *config.Account, userID, accessToken, tokenEndpoint, issuerURL, scopes string) error {
	clientID := strings.TrimSpace(account.ClientID)
	tokenEndpoint = strings.TrimSpace(tokenEndpoint)
	issuerURL = strings.TrimRight(strings.TrimSpace(issuerURL), "/")
	scopes = strings.TrimSpace(scopes)

	derivedEndpoint, derivedIssuer, derivedScopes := auth.DeriveExternalIdpEndpoints(userID, clientID, accessToken)
	if issuerURL == "" {
		issuerURL = derivedIssuer
	}
	if issuerURL == "" && tokenEndpoint != "" {
		if endpoint, issuer, fromEndpoint := auth.ExternalIdpConfigurationFromTokenEndpoint(tokenEndpoint, clientID); endpoint != "" {
			tokenEndpoint, issuerURL = endpoint, issuer
			if scopes == "" {
				scopes = fromEndpoint
			}
		}
	}
	if issuerURL != "" {
		endpoint, issuer, fromIssuer := auth.ExternalIdpConfigurationFromIssuer(issuerURL, clientID)
		if tokenEndpoint == "" {
			tokenEndpoint = endpoint
		}
		if issuer != "" {
			issuerURL = issuer
		}
		if scopes == "" {
			scopes = fromIssuer
		}
	}
	if tokenEndpoint == "" {
		tokenEndpoint = derivedEndpoint
	}
	if scopes == "" {
		scopes = derivedScopes
	}
	normalized, err := auth.NormalizeExternalIdpScopes(scopes, clientID)
	if err != nil {
		return err
	}
	if err := auth.ValidateExternalIdpConfiguration(clientID, tokenEndpoint, issuerURL, normalized); err != nil {
		return err
	}
	account.ClientID = clientID
	account.ClientSecret = ""
	account.TokenEndpoint = tokenEndpoint
	account.IssuerURL = issuerURL
	account.Scopes = normalized
	return nil
}

func verifyOfferedProfile(ctx context.Context, account *config.Account, profileArn string) error {
	ctx, cancel := context.WithTimeout(ctx, microsoftDiscoveryTimeout)
	defer cancel()
	profiles, err := DiscoverKiroProfiles(ctx, account)
	if err != nil {
		return errors.New("Unable to verify profileArn against Kiro profiles: " + err.Error())
	}
	for _, profile := range profiles {
		if profile.ARN == profileArn {
			return nil
		}
	}
	return errors.New("profileArn was not offered for this credential")
}
