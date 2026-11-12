package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
	"kiro-proxy/proxypool"
)

// codeDuplicatesChanged is a merge whose accounts no longer form one duplicate
// group (an account was added, removed or merged since the list was read).
const codeDuplicatesChanged = "duplicates_changed"

const maxMergeAccountIDs = 100

// duplicateMergeMu runs one merge at a time, so two confirmations of one group
// cannot both delete rows.
var duplicateMergeMu sync.Mutex

// duplicateAccountView is one account of a duplicate group: what an operator
// needs to choose the keeper, and no secret.
type duplicateAccountView struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	Nickname     string `json:"nickname"`
	AuthMethod   string `json:"authMethod"`
	Provider     string `json:"provider"`
	Region       string `json:"region"`
	Enabled      bool   `json:"enabled"`
	Healthy      bool   `json:"healthy"`
	BanStatus    string `json:"banStatus"`
	Silent       bool   `json:"silent"`
	LastRefresh  int64  `json:"lastRefresh"`
	ExpiresAt    int64  `json:"expiresAt"`
	LastUsed     int64  `json:"lastUsed"`
	RequestCount int    `json:"requestCount"`
	ErrorCount   int    `json:"errorCount"`
}

type duplicateGroupView struct {
	Reasons         []string               `json:"reasons"`
	SuggestedKeepID string                 `json:"suggestedKeepId"`
	Accounts        []duplicateAccountView `json:"accounts"`
}

// accountSavedRef is the {id, email, updated} an add or import answers with;
// updated is true when the login refreshed an account that was already stored.
func accountSavedRef(account config.Account, updated bool) map[string]interface{} {
	return map[string]interface{}{"id": account.ID, "email": account.Email, "updated": updated}
}

func (h *Handler) poolStatsByID() map[string]config.Account {
	stats := make(map[string]config.Account)
	for _, a := range h.pool.GetAllAccounts() {
		stats[a.ID] = a
	}
	return stats
}

// apiListDuplicateAccounts answers GET /accounts/duplicates.
func (h *Handler) apiListDuplicateAccounts(w http.ResponseWriter, _ *http.Request) {
	accounts := config.GetAccounts()
	byID := make(map[string]config.Account, len(accounts))
	for _, a := range accounts {
		byID[a.ID] = a
	}
	stats := h.poolStatsByID()

	groups := config.FindDuplicateGroups(accounts)
	views := make([]duplicateGroupView, 0, len(groups))
	duplicates := 0
	for _, group := range groups {
		duplicates += len(group.IDs) - 1
		view := duplicateGroupView{
			Reasons:         group.Reasons,
			SuggestedKeepID: group.SuggestedKeepID,
			Accounts:        make([]duplicateAccountView, 0, len(group.IDs)),
		}
		for _, id := range group.IDs {
			a := byID[id]
			counters := accountStats(stats, a)
			view.Accounts = append(view.Accounts, duplicateAccountView{
				ID:           a.ID,
				Email:        a.Email,
				Nickname:     a.Nickname,
				AuthMethod:   a.AuthMethod,
				Provider:     a.Provider,
				Region:       a.Region,
				Enabled:      a.Enabled,
				Healthy:      config.IsHealthyAccount(&a),
				BanStatus:    a.BanStatus,
				Silent:       a.Silent,
				LastRefresh:  a.LastRefresh,
				ExpiresAt:    a.ExpiresAt,
				LastUsed:     counters.LastUsed,
				RequestCount: counters.RequestCount,
				ErrorCount:   counters.ErrorCount,
			})
		}
		views = append(views, view)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"duplicateCount": duplicates,
		"groups":         views,
	})
}

// apiMergeDuplicateAccounts answers POST /accounts/duplicates/merge with
// {"keepId": "...", "ids": ["..."]}: the kept account stays, the others go,
// their counters are summed into it and their request history points at it.
func (h *Handler) apiMergeDuplicateAccounts(w http.ResponseWriter, r *http.Request) {
	var req struct {
		KeepID string   `json:"keepId"`
		IDs    []string `json:"ids"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	keepID := strings.TrimSpace(req.KeepID)
	if keepID == "" {
		writeAdminError(w, http.StatusBadRequest, codeNoAccountIDs, "keepId is required")
		return
	}
	if len(req.IDs) > maxMergeAccountIDs {
		writeAdminError(w, http.StatusBadRequest, codeNoAccountIDs, "at most 100 account ids can be merged at once")
		return
	}
	seen := map[string]bool{keepID: true}
	var removeIDs []string
	for _, id := range req.IDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		removeIDs = append(removeIDs, id)
	}
	if len(removeIDs) == 0 {
		writeAdminError(w, http.StatusBadRequest, codeNoAccountIDs, "ids must name at least one account besides keepId")
		return
	}

	duplicateMergeMu.Lock()
	defer duplicateMergeMu.Unlock()

	accounts := config.GetAccounts()
	if !sameDuplicateGroup(config.FindDuplicateGroups(accounts), keepID, removeIDs) {
		writeAdminError(w, http.StatusConflict, codeDuplicatesChanged, "These accounts are no longer duplicates of each other. Review the duplicates again.")
		return
	}

	//! A merge deletes accounts and their secrets, so it never runs without a restore point.
	if _, err := config.CreateBackup("auto", "before merging duplicate accounts"); err != nil {
		writeAdminErr(w, http.StatusInternalServerError, fmt.Errorf("could not back up before the merge: %w", err), "")
		return
	}

	stats := h.poolStatsByID()
	var counters config.AccountCounters
	for _, a := range accounts {
		if !seen[a.ID] {
			continue
		}
		c := accountStats(stats, a)
		counters.RequestCount += c.RequestCount
		counters.ErrorCount += c.ErrorCount
		counters.TotalTokens += c.TotalTokens
		counters.TotalCredits += c.TotalCredits
		counters.LastUsed = max(counters.LastUsed, c.LastUsed)
	}

	kept, err := config.MergeAccounts(keepID, removeIDs, counters)
	if errors.Is(err, config.ErrAccountNotFound) {
		writeAdminError(w, http.StatusConflict, codeDuplicatesChanged, "These accounts are no longer duplicates of each other. Review the duplicates again.")
		return
	}
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, fmt.Errorf("could not merge the accounts: %w", err), "")
		return
	}
	h.pool.Reload()
	//! The kept account keeps its own pool proxy; the removed copies give theirs up.
	proxypool.Default().ForgetAccounts(removeIDs...)

	moved, err := moveAccountHistory(keepID, removeIDs)
	if err != nil {
		//! The accounts are merged already; old rows keep the removed id and still count in totals.
		logger.Warnf("[Accounts] Merged duplicates into %s, but could not move their request history: %v", kept.ID, err)
	}
	logger.Infof("[Accounts] Merged %d duplicate account(s) into %s", len(removeIDs), kept.ID)
	//! The merge moves keys bound to a removed copy onto the kept account; open key lists refetch.
	publishEvent(eventAPIKeysChanged, kept.ID)

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"keptId":        kept.ID,
		"removed":       removeIDs,
		"requestsMoved": moved,
	})
}

// sameDuplicateGroup is true when keepID and every id in others are in one
// current duplicate group.
func sameDuplicateGroup(groups []config.DuplicateGroup, keepID string, others []string) bool {
	for _, group := range groups {
		members := make(map[string]bool, len(group.IDs))
		for _, id := range group.IDs {
			members[id] = true
		}
		if !members[keepID] {
			continue
		}
		for _, id := range others {
			if !members[id] {
				return false
			}
		}
		return true
	}
	return false
}

// moveAccountHistory points the request and error rows of removed accounts at
// the kept one, so the history matches the summed counters. It reports how
// many request rows moved.
func moveAccountHistory(keepID string, removed []string) (int64, error) {
	if len(removed) == 0 {
		return 0, nil
	}
	d, err := db.Get()
	if err != nil {
		return 0, err
	}
	tx, err := d.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(removed)), ",")
	args := make([]interface{}, 0, len(removed)+1)
	args = append(args, keepID)
	for _, id := range removed {
		args = append(args, id)
	}
	res, err := tx.Exec(`UPDATE requests SET account_id=? WHERE account_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return 0, err
	}
	moved, _ := res.RowsAffected()
	if _, err := tx.Exec(`UPDATE errors SET account_id=? WHERE account_id IN (`+placeholders+`)`, args...); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return moved, nil
}
