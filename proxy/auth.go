package proxy

import (
	"context"
	"net/http"
	"strings"

	"kiro-proxy/config"
)

type apiKeyContextKey struct{}

type apiKeyContextValue struct {
	id  string
	key string
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
	if overToken, overCredit := config.ApiKeyOverLimit(*entry); overToken || overCredit {
		if overToken {
			return nil, newAuthError(http.StatusTooManyRequests, "rate_limit_error", "token limit exceeded")
		}
		return nil, newAuthError(http.StatusTooManyRequests, "rate_limit_error", "credit limit exceeded")
	}
	return entry, nil
}

func (h *Handler) authenticateForClaude(w http.ResponseWriter, r *http.Request) *http.Request {
	entry, err := h.authenticate(r)
	if err != nil {
		ae, _ := err.(*authError)
		if ae == nil {
			ae = newAuthError(http.StatusUnauthorized, "authentication_error", err.Error())
		}
		h.sendClaudeError(w, ae.status, ae.code, ae.message)
		return nil
	}
	return withApiKeyContext(r, entry)
}

func (h *Handler) authenticateForOpenAI(w http.ResponseWriter, r *http.Request) *http.Request {
	entry, err := h.authenticate(r)
	if err != nil {
		ae, _ := err.(*authError)
		if ae == nil {
			ae = newAuthError(http.StatusUnauthorized, "authentication_error", err.Error())
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
	return r.WithContext(context.WithValue(r.Context(), apiKeyContextKey{}, apiKeyContextValue{
		id:  entry.ID,
		key: entry.Key,
	}))
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

func tokenBudget(estimatedInputTokens, maxOutputTokens int) int64 {
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
