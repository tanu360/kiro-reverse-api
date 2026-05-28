package proxy

import (
	"encoding/json"
	"net/http"

	"kiro-proxy/config"
)

type apiKeyView struct {
	ID            string  `json:"id"`
	Name          string  `json:"name,omitempty"`
	Key           string  `json:"key,omitempty"`
	KeyMasked     string  `json:"keyMasked"`
	Enabled       bool    `json:"enabled"`
	CreatedAt     int64   `json:"createdAt"`
	LastUsedAt    int64   `json:"lastUsedAt,omitempty"`
	TokenLimit    int64   `json:"tokenLimit,omitempty"`
	CreditLimit   float64 `json:"creditLimit,omitempty"`
	TokensUsed    int64   `json:"tokensUsed"`
	CreditsUsed   float64 `json:"creditsUsed"`
	RequestsCount int64   `json:"requestsCount"`
}

func toApiKeyView(entry config.ApiKeyEntry) apiKeyView {
	return apiKeyView{
		ID:            entry.ID,
		Name:          entry.Name,
		KeyMasked:     config.MaskApiKey(entry.Key),
		Enabled:       entry.Enabled,
		CreatedAt:     entry.CreatedAt,
		LastUsedAt:    entry.LastUsedAt,
		TokenLimit:    entry.TokenLimit,
		CreditLimit:   entry.CreditLimit,
		TokensUsed:    entry.TokensUsed,
		CreditsUsed:   entry.CreditsUsed,
		RequestsCount: entry.RequestsCount,
	}
}

func toApiKeyDetailView(entry config.ApiKeyEntry) apiKeyView {
	view := toApiKeyView(entry)
	view.Key = entry.Key
	return view
}

func (h *Handler) apiListApiKeys(w http.ResponseWriter, _ *http.Request) {
	entries := config.ListApiKeys()
	out := make([]apiKeyView, len(entries))
	for i, entry := range entries {
		out[i] = toApiKeyView(entry)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"apiKeys": out})
}

func (h *Handler) apiGetApiKey(w http.ResponseWriter, _ *http.Request, id string) {
	entry := config.GetApiKeyEntry(id)
	if entry == nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "API key not found"})
		return
	}
	json.NewEncoder(w).Encode(toApiKeyDetailView(*entry))
}

type apiKeyCreateRequest struct {
	Name        string  `json:"name,omitempty"`
	Key         string  `json:"key,omitempty"`
	Enabled     *bool   `json:"enabled,omitempty"`
	TokenLimit  int64   `json:"tokenLimit,omitempty"`
	CreditLimit float64 `json:"creditLimit,omitempty"`
}

func (h *Handler) apiCreateApiKey(w http.ResponseWriter, r *http.Request) {
	var req apiKeyCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	keyValue := req.Key
	if keyValue == "" {
		keyValue = config.GenerateApiKeyValue()
	}

	entry, err := config.AddApiKey(config.ApiKeyEntry{
		Name:        req.Name,
		Key:         keyValue,
		Enabled:     enabled,
		TokenLimit:  req.TokenLimit,
		CreditLimit: req.CreditLimit,
	})
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"id":      entry.ID,
		"key":     entry.Key,
		"apiKey":  toApiKeyView(entry),
	})
}

type apiKeyUpdateRequest struct {
	Name        *string  `json:"name,omitempty"`
	Key         *string  `json:"key,omitempty"`
	Enabled     *bool    `json:"enabled,omitempty"`
	TokenLimit  *int64   `json:"tokenLimit,omitempty"`
	CreditLimit *float64 `json:"creditLimit,omitempty"`
}

func (h *Handler) apiUpdateApiKey(w http.ResponseWriter, r *http.Request, id string) {
	existing := config.GetApiKeyEntry(id)
	if existing == nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "API key not found"})
		return
	}

	var req apiKeyUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	patch := *existing
	if req.Name != nil {
		patch.Name = *req.Name
	}
	if req.Key != nil {
		patch.Key = *req.Key
	}
	if req.Enabled != nil {
		patch.Enabled = *req.Enabled
	}
	if req.TokenLimit != nil {
		patch.TokenLimit = *req.TokenLimit
	}
	if req.CreditLimit != nil {
		patch.CreditLimit = *req.CreditLimit
	}

	if err := config.UpdateApiKey(id, patch); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	updated := config.GetApiKeyEntry(id)
	if updated == nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "failed to reload API key"})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"apiKey":  toApiKeyView(*updated),
	})
}

func (h *Handler) apiDeleteApiKey(w http.ResponseWriter, _ *http.Request, id string) {
	if err := config.DeleteApiKey(id); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiResetApiKeyUsage(w http.ResponseWriter, _ *http.Request, id string) {
	if err := config.ResetApiKeyUsage(id); err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	updated := config.GetApiKeyEntry(id)
	if updated == nil {
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"apiKey":  toApiKeyView(*updated),
	})
}
