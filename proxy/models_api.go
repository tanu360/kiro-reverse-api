package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// modelsCreatedAt is the creation time every listed model reports. Kiro gives none, and the
// SDKs need a value: Anthropic's created_at (RFC 3339) and OpenAI's created (Unix seconds).
var modelsCreatedAt = time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)

// modelDisplayName is a readable name for an id: "claude-haiku-4.5" reads "Claude Haiku 4.5".
// Other ids keep their spelling.
func modelDisplayName(id string) string {
	if !strings.HasPrefix(strings.ToLower(id), "claude-") {
		return id
	}
	parts := strings.Split(id, "-")
	for i, part := range parts {
		if part == "" {
			continue
		}
		runes := []rune(part)
		runes[0] = unicode.ToUpper(runes[0])
		parts[i] = string(runes)
	}
	return strings.Join(parts, " ")
}

// writeModelsList answers /v1/models. Both shapes share the body: OpenAI's object and data, and
// Anthropic's has_more, first_id and last_id. An Anthropic client may page with limit,
// after_id and before_id; without limit the whole list comes back.
func writeModelsList(w http.ResponseWriter, r *http.Request, models []map[string]interface{}) {
	query := r.URL.Query()
	page := models
	hasMore := false
	if afterID := query.Get("after_id"); afterID != "" {
		if i := modelIndex(models, afterID); i >= 0 {
			page = models[i+1:]
		}
	} else if beforeID := query.Get("before_id"); beforeID != "" {
		if i := modelIndex(models, beforeID); i >= 0 {
			page = models[:i]
		}
	}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 1000 {
			sendModelsError(w, r, http.StatusBadRequest, "invalid_request_error", "limit must be a whole number from 1 to 1000")
			return
		}
		if len(page) > limit {
			if query.Get("before_id") != "" && query.Get("after_id") == "" {
				page = page[len(page)-limit:]
			} else {
				page = page[:limit]
			}
			hasMore = true
		}
	}
	var firstID, lastID interface{}
	if len(page) > 0 {
		firstID, lastID = page[0]["id"], page[len(page)-1]["id"]
	}
	if page == nil {
		page = []map[string]interface{}{}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"object":   "list",
		"data":     page,
		"has_more": hasMore,
		"first_id": firstID,
		"last_id":  lastID,
	})
}

func modelIndex(models []map[string]interface{}, id string) int {
	for i, m := range models {
		if s, _ := m["id"].(string); strings.EqualFold(s, id) {
			return i
		}
	}
	return -1
}

// handleModel answers GET /v1/models/{id} from the same list /v1/models gives the key.
func (h *Handler) handleModel(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		sendModelsError(w, r, http.StatusMethodNotAllowed, "invalid_request_error", "Method Not Allowed")
		return
	}
	models := h.listedModels(r)
	if i := modelIndex(models, strings.TrimSpace(id)); i >= 0 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(models[i])
		return
	}
	sendModelsError(w, r, http.StatusNotFound, "not_found_error", fmt.Sprintf("model %q is not available on any account", id))
}

// sendModelsError writes an error in the shape the client speaks: Anthropic's when it sent
// anthropic-version, OpenAI's otherwise.
func sendModelsError(w http.ResponseWriter, r *http.Request, status int, errType, message string) {
	if r.Header.Get("anthropic-version") != "" {
		(&Handler{}).sendClaudeError(w, status, errType, message)
		return
	}
	if errType == "not_found_error" {
		errType = "invalid_request_error"
	}
	(&Handler{}).sendOpenAIError(w, status, errType, message)
}

// sendClientNotFound answers a /v1 path the proxy does not serve with a JSON error, so SDKs show
// the message instead of failing to parse a text body.
func sendClientNotFound(w http.ResponseWriter, r *http.Request) {
	sendModelsError(w, r, http.StatusNotFound, "not_found_error", fmt.Sprintf("%s %s is not an endpoint this server has", r.Method, r.URL.Path))
}

// openAIErrorCode fills the code and param fields of an OpenAI error body for the errors that
// have an OpenAI code. Others carry null, as the OpenAI API does for errors without one.
func openAIErrorCode(status int, message string) (code, param interface{}) {
	switch {
	case status == http.StatusNotFound && strings.Contains(message, "is not available on any account"):
		return "model_not_found", "model"
	case status == http.StatusNotFound && strings.Contains(message, "is not an endpoint"):
		return "unknown_url", nil
	case status == http.StatusUnauthorized:
		return "invalid_api_key", nil
	case status == http.StatusTooManyRequests:
		return "rate_limit_exceeded", nil
	case status == http.StatusBadRequest:
		//! A validation message starts with the field it is about.
		for _, field := range []string{"top_logprobs", "logprobs", "n", "stop", "max_tokens", "messages", "tool_choice", "response_format", "input"} {
			if strings.HasPrefix(message, field+" ") || strings.HasPrefix(message, field+"[") || strings.HasPrefix(message, field+":") {
				return nil, field
			}
		}
	}
	return nil, nil
}
