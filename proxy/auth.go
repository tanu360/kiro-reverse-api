package proxy

import (
	"context"
	"net/http"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/pool"
)

type apiKeyContextKey struct{}

type apiKeyContextValue struct {
	id  string
	key string
	// allowed is the key's account allowlist as a set, taken at auth: its
	// account ids plus the accounts carrying one of its tags. nil is every
	// account; an empty set is a scope that matches no account.
	allowed map[string]bool
	// mode is the key's own routing mode; "" follows the global one.
	mode string
	// allowedModels is the models the key may call; empty is every model.
	allowedModels []string
	// accountTags is the key's tag scope, named in its no-account error.
	accountTags []string
}

type apiKeyUsageReservation struct {
	id              string
	key             string
	reservedTokens  int64
	reservedCredits float64
	done            bool
}

type authError struct {
	status  int
	code    string
	message string
	// retryAfter is when a 429 for the key's own RPM limit clears; such a
	// refusal stays retryable, unlike a used-up token, credit or call limit.
	retryAfter time.Duration
}

func (e *authError) Error() string {
	return e.message
}

func newAuthError(status int, code, message string) *authError {
	return &authError{status: status, code: code, message: message}
}

func extractProvidedKey(r *http.Request) string {
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	}
	return strings.TrimSpace(r.Header.Get("X-Api-Key"))
}

func (h *Handler) authenticate(r *http.Request) (*config.ApiKeyEntry, error) {
	if !config.IsApiKeyRequired() {
		return nil, nil
	}

	provided := extractProvidedKey(r)
	if provided == "" {
		return nil, newAuthError(http.StatusUnauthorized, "authentication_error", "Invalid or missing API key")
	}
	if !config.HasApiKeys() {
		return nil, newAuthError(http.StatusUnauthorized, "authentication_error", "API key authentication is required but no keys are configured")
	}
	entry := config.FindApiKeyByValue(provided)
	if entry == nil {
		return nil, newAuthError(http.StatusUnauthorized, "authentication_error", "Invalid or missing API key")
	}
	if !entry.Enabled {
		return nil, newAuthError(http.StatusUnauthorized, "authentication_error", "API key disabled")
	}
	if config.ApiKeyExpired(*entry, time.Now()) {
		return nil, newAuthError(http.StatusUnauthorized, "authentication_error", apiKeyExpiredMessage(entry.ExpiresAt))
	}
	if overToken, overCredit := config.ApiKeyOverLimit(*entry); overToken || overCredit {
		if overToken {
			return nil, newAuthError(http.StatusTooManyRequests, "rate_limit_error", "token limit exceeded")
		}
		return nil, newAuthError(http.StatusTooManyRequests, "rate_limit_error", "credit limit exceeded")
	}
	if err := config.ApiKeyCallLimitError(*entry); err != nil {
		return nil, newAuthError(http.StatusTooManyRequests, "rate_limit_error", err.Error())
	}
	return entry, nil
}

func (h *Handler) authenticateForClaude(w http.ResponseWriter, r *http.Request) *http.Request {
	return h.authenticateForClaudeWithRequestLog(w, r, false)
}

func (h *Handler) authenticateForClaudeRequest(w http.ResponseWriter, r *http.Request) *http.Request {
	return h.authenticateForClaudeWithRequestLog(w, r, true)
}

func (h *Handler) authenticateForClaudeWithRequestLog(w http.ResponseWriter, r *http.Request, recordRequest bool) *http.Request {
	entry, err := h.authenticate(r)
	if err == nil && recordRequest {
		err = takeApiKeyRPM(entry, time.Now())
	}
	if err != nil {
		ae, _ := err.(*authError)
		if ae == nil {
			ae = newAuthError(http.StatusUnauthorized, "authentication_error", err.Error())
		}
		if recordRequest {
			provided := extractProvidedKey(r)
			recordFinalRequestWithAPIKey(r.Context(), rejectedKeyID(provided), provided, nil, rejectedRequestModel(r), 0, 0, 0, false, ae.status, ae.message)
		}
		if ae.retryAfter > 0 {
			noteRetryAfter(r.Context(), ae.retryAfter)
		} else if ae.status == http.StatusTooManyRequests {
			//! Every other 429 here is the key's own limit, already reached.
			markNoRetry(w)
		}
		h.sendClaudeError(w, ae.status, ae.code, ae.message)
		return nil
	}
	return withApiKeyContext(r, entry)
}

func (h *Handler) authenticateForOpenAI(w http.ResponseWriter, r *http.Request) *http.Request {
	return h.authenticateForOpenAIWithRequestLog(w, r, false)
}

func (h *Handler) authenticateForOpenAIRequest(w http.ResponseWriter, r *http.Request) *http.Request {
	return h.authenticateForOpenAIWithRequestLog(w, r, true)
}

func (h *Handler) authenticateForOpenAIWithRequestLog(w http.ResponseWriter, r *http.Request, recordRequest bool) *http.Request {
	entry, err := h.authenticate(r)
	if err == nil && recordRequest {
		err = takeApiKeyRPM(entry, time.Now())
	}
	if err != nil {
		ae, _ := err.(*authError)
		if ae == nil {
			ae = newAuthError(http.StatusUnauthorized, "authentication_error", err.Error())
		}
		if recordRequest {
			provided := extractProvidedKey(r)
			recordFinalRequestWithAPIKey(r.Context(), rejectedKeyID(provided), provided, nil, rejectedRequestModel(r), 0, 0, 0, false, ae.status, ae.message)
		}
		if ae.retryAfter > 0 {
			noteRetryAfter(r.Context(), ae.retryAfter)
		} else if ae.status == http.StatusTooManyRequests {
			//! Every other 429 here is the key's own limit, already reached.
			markNoRetry(w)
		}
		h.sendOpenAIError(w, ae.status, ae.code, ae.message)
		return nil
	}
	return withApiKeyContext(r, entry)
}

func withApiKeyContext(r *http.Request, entry *config.ApiKeyEntry) *http.Request {
	if entry == nil {
		return r
	}
	noteResponseKeyID(r.Context(), entry.ID)
	var allowed map[string]bool
	if len(entry.AccountTags) > 0 {
		//! Tags resolve per request, so a tag edit on an account applies to the next request.
		allowed = config.ApiKeyAllowedAccounts(*entry, config.GetAccounts())
	} else {
		allowed = pool.AllowedSet(entry.AccountIDs)
	}
	return r.WithContext(context.WithValue(r.Context(), apiKeyContextKey{}, apiKeyContextValue{
		id:            entry.ID,
		key:           entry.Key,
		allowed:       allowed,
		mode:          entry.RoutingMode,
		allowedModels: append([]string(nil), entry.AllowedModels...),
		accountTags:   append([]string(nil), entry.AccountTags...),
	}))
}

// apiKeyFromContext is the request's client key as auth saw it.
func apiKeyFromContext(ctx context.Context) (apiKeyContextValue, bool) {
	if ctx == nil {
		return apiKeyContextValue{}, false
	}
	v, ok := ctx.Value(apiKeyContextKey{}).(apiKeyContextValue)
	return v, ok
}

// poolScopeFromContext is the pool view of the request's key: its accounts
// and its routing mode. A request without a key sees the whole pool with the
// global mode.
func poolScopeFromContext(ctx context.Context) pool.Scope {
	v, _ := apiKeyFromContext(ctx)
	return pool.Scope{Allowed: v.allowed, Mode: v.mode}
}

func apiKeyIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	switch v := ctx.Value(apiKeyContextKey{}).(type) {
	case apiKeyContextValue:
		return v.id
	case string:
		return v
	default:
		return ""
	}
}

func apiKeyValueFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(apiKeyContextKey{}).(apiKeyContextValue); ok {
		return v.key
	}
	return ""
}

func (r *apiKeyUsageReservation) apiKeyID() string {
	if r == nil {
		return ""
	}
	return r.id
}

func (r *apiKeyUsageReservation) apiKeyValue() string {
	if r == nil {
		return ""
	}
	return r.key
}

func tokenBudget(estimatedInputTokens int) int64 {
	if estimatedInputTokens < 1 {
		estimatedInputTokens = 1
	}
	return int64(estimatedInputTokens)
}

func reserveApiKeyUsage(apiKeyID, apiKey string, tokenBudget int64) (*apiKeyUsageReservation, error) {
	if apiKeyID == "" {
		return nil, nil
	}
	if tokenBudget < 1 {
		tokenBudget = 1
	}
	reservedCredits, err := config.ReserveApiKeyRequestUsage(apiKeyID, tokenBudget)
	if err != nil {
		return nil, err
	}
	return &apiKeyUsageReservation{id: apiKeyID, key: apiKey, reservedTokens: tokenBudget, reservedCredits: reservedCredits}, nil
}

func (r *apiKeyUsageReservation) release() {
	if r == nil || r.done || r.id == "" {
		return
	}
	if err := config.ReleaseApiKeyUsageReservation(r.id, r.reservedTokens, r.reservedCredits); err != nil {
		_ = err
	}
	r.done = true
}

func (r *apiKeyUsageReservation) finalize(actualTokens int64, actualCredits float64) error {
	if r == nil || r.done || r.id == "" {
		return nil
	}
	r.done = true
	return config.FinalizeApiKeyUsageReservation(r.id, r.reservedTokens, r.reservedCredits, actualTokens, actualCredits)
}
