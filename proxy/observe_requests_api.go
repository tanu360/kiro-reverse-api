// Package proxy: observe recent requests API.
package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// apiObserveRecentRequests GET /admin/api/observe/recent-requests?limit=100
func (h *Handler) apiObserveRecentRequests(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 100
	if limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	reqs := getObserveStore().RecentRequests(limit)
	json.NewEncoder(w).Encode(map[string]interface{}{"requests": reqs})
}
