package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"kiro-proxy/config"
)

func (h *Handler) apiObserveOverview(w http.ResponseWriter, _ *http.Request) {
	snap := getObserveStore().Overview()
	snap.EnabledAccts, snap.AvailableAccts = h.accountAvailabilityNow()
	json.NewEncoder(w).Encode(snap)
}

// apiObserveHeatmap serves per-minute traffic for the global row and each
// account. Query params, all optional:
//   - windowMin: minutes back, 1..1440 (default 60).
//   - bucketMin: minutes summed per cell (default 1).
//   - scope=global: leave the accounts out.
//   - top=N: only the N busiest accounts over the last hour, busiest first,
//     plus restCount for the busy ones left out.
//   - sparse=1: leave out cells with no traffic; offsets still place the rest.
//
// With none set the response is the original dense, every-account one.
func (h *Handler) apiObserveHeatmap(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	positive := func(name string) int {
		if n, err := strconv.Atoi(q.Get(name)); err == nil && n > 0 {
			return n
		}
		return 0
	}
	opts := HeatmapOptions{
		WindowMin:  positive("windowMin"),
		BucketMin:  positive("bucketMin"),
		GlobalOnly: strings.EqualFold(q.Get("scope"), "global"),
		Top:        positive("top"),
		Sparse:     queryFlag(q.Get("sparse")),
	}
	resp := getObserveStore().HeatmapWith(opts)

	type enriched struct {
		AccountID string        `json:"accountId"`
		Email     string        `json:"email,omitempty"`
		Cells     []HeatmapCell `json:"cells"`
	}
	out := struct {
		WindowMin int        `json:"windowMin"`
		BucketMin int        `json:"bucketMin"`
		NowUnix   int64      `json:"nowUnix"`
		Global    enriched   `json:"global"`
		Accounts  []enriched `json:"accounts,omitempty"`
		RestCount *int       `json:"restCount,omitempty"`
	}{
		WindowMin: resp.WindowMin,
		BucketMin: resp.BucketMin,
		NowUnix:   resp.NowUnix,
		Global:    enriched{AccountID: resp.Global.AccountID, Cells: resp.Global.Cells},
		RestCount: resp.RestCount,
	}
	if len(resp.Accounts) > 0 {
		emailMap := map[string]string{}
		for _, a := range config.GetAccounts() {
			emailMap[a.ID] = a.Email
		}
		out.Accounts = make([]enriched, 0, len(resp.Accounts))
		for _, a := range resp.Accounts {
			out.Accounts = append(out.Accounts, enriched{
				AccountID: a.AccountID,
				Email:     emailMap[a.AccountID],
				Cells:     a.Cells,
			})
		}
	}
	json.NewEncoder(w).Encode(out)
}

func queryFlag(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
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
