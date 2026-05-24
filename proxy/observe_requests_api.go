// Package proxy: observe recent requests API.
package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// apiObserveRecentRequests GET /admin/api/observe/recent-requests?page=1&pageSize=25&search=&status=&sort=time&order=desc
func (h *Handler) apiObserveRecentRequests(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	page := 1
	if parsed, err := strconv.Atoi(query.Get("page")); err == nil && parsed > 0 {
		page = parsed
	}
	pageSize := 25
	if parsed, err := strconv.Atoi(query.Get("pageSize")); err == nil && parsed > 0 {
		pageSize = parsed
	} else if parsed, err := strconv.Atoi(query.Get("limit")); err == nil && parsed > 0 {
		pageSize = parsed
	}
	pageData := getObserveStore().RequestPage(requestQuery{
		Page:     page,
		PageSize: pageSize,
		Search:   query.Get("search"),
		Status:   query.Get("status"),
		Sort:     query.Get("sort"),
		Order:    query.Get("order"),
	})
	json.NewEncoder(w).Encode(pageData)
}
