package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"

	"kiro-proxy/config"
)

func (h *Handler) apiObserveOverview(w http.ResponseWriter, _ *http.Request) {
	snap := getObserveStore().Overview()
	json.NewEncoder(w).Encode(snap)
}

func (h *Handler) apiObserveHeatmap(w http.ResponseWriter, r *http.Request) {
	windowMin := 60
	if v := r.URL.Query().Get("windowMin"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			windowMin = n
		}
	}
	resp := getObserveStore().Heatmap(windowMin)

	emailMap := map[string]string{}
	for _, a := range config.GetAccounts() {
		emailMap[a.ID] = a.Email
	}
	type enriched struct {
		AccountID string        `json:"accountId"`
		Email     string        `json:"email,omitempty"`
		Cells     []HeatmapCell `json:"cells"`
	}
	out := struct {
		WindowMin int        `json:"windowMin"`
		NowUnix   int64      `json:"nowUnix"`
		Global    enriched   `json:"global"`
		Accounts  []enriched `json:"accounts"`
	}{
		WindowMin: resp.WindowMin,
		NowUnix:   resp.NowUnix,
		Global:    enriched{AccountID: resp.Global.AccountID, Cells: resp.Global.Cells},
	}
	for _, a := range resp.Accounts {
		out.Accounts = append(out.Accounts, enriched{
			AccountID: a.AccountID,
			Email:     emailMap[a.AccountID],
			Cells:     a.Cells,
		})
	}
	json.NewEncoder(w).Encode(out)
}

func (h *Handler) apiObserveModelMix(w http.ResponseWriter, _ *http.Request) {
	mix := getObserveStore().ModelMix()
	json.NewEncoder(w).Encode(map[string]interface{}{"models": mix})
}

func (h *Handler) apiObserveRecentErrors(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	errs := getObserveStore().RecentErrors(limit)
	json.NewEncoder(w).Encode(map[string]interface{}{"errors": errs})
}
