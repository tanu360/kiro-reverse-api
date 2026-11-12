package proxy

import (
	"encoding/json"
	"errors"
	"net/http"

	"kiro-proxy/config"
)

// apiGetResponseHeaders answers GET /admin/api/response-headers: the list, the variables a
// value may use and the size limit.
func (h *Handler) apiGetResponseHeaders(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"headers":   config.GetResponseHeaders(),
		"variables": config.ResponseHeaderVariables,
		"max":       config.MaxResponseHeaders,
	})
}

// apiUpdateResponseHeaders answers POST /admin/api/response-headers {"headers":[...]}: it
// replaces the whole list. A rejected entry answers 400 with its code and index.
func (h *Handler) apiUpdateResponseHeaders(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Headers []config.ResponseHeaderRule `json:"headers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if err := config.UpdateResponseHeaders(req.Headers); err != nil {
		var headerErr *config.ResponseHeaderError
		if errors.As(err, &headerErr) {
			body := map[string]interface{}{"error": headerErr.Reason, "code": headerErr.Code, "index": headerErr.Index}
			for name, value := range headerErr.Params {
				body[name] = value
			}
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(body)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}
