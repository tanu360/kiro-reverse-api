package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/db"
	"kiro-proxy/logger"
)

// Admin API codes of conversations and replays.
const (
	codeRequestNotFound     = "request_not_found"
	codeRequestBodyMissing  = "request_body_missing"
	codeReplayAccount       = "replay_account_invalid"
	codeConversationMissing = "conversation_not_found"
)

const (
	// maxConversationTurns caps one conversation's turns in the detail view.
	maxConversationTurns = 500
	// replayTimeout bounds one replay; it runs without streaming.
	replayTimeout = 5 * time.Minute
	// maxReplayResponseBytes caps the answer a replay shows.
	maxReplayResponseBytes = 1 << 20
)

// conversationTotals sums one conversation's turns.
type conversationTotals struct {
	Requests    int      `json:"requests"`
	Successes   int      `json:"successes"`
	Failures    int      `json:"failures"`
	Failovers   int      `json:"failovers"`
	Replays     int      `json:"replays"`
	InTokens    int      `json:"inTokens"`
	OutTokens   int      `json:"outTokens"`
	CacheRead   int      `json:"cacheReadTokens"`
	Credits     float64  `json:"credits"`
	DurationMs  int64    `json:"durationMs"`
	FirstTS     int64    `json:"firstTs"`
	LastTS      int64    `json:"lastTs"`
	Accounts    []string `json:"accounts"`
	Models      []string `json:"models"`
	AccountMove int      `json:"accountMoves"`
}

type conversationView struct {
	ID        string             `json:"id"`
	Turns     []requestRecord    `json:"turns"`
	Totals    conversationTotals `json:"totals"`
	Truncated bool               `json:"truncated"`
}

func loadConversation(id string) (conversationView, error) {
	view := conversationView{ID: id, Turns: []requestRecord{}}
	d, err := db.Get()
	if err != nil {
		return view, err
	}
	rows, err := d.Query(`SELECT `+requestColumns+` FROM requests WHERE conversation_id = ? ORDER BY ts ASC, id ASC LIMIT ?`, id, maxConversationTurns+1)
	if err != nil {
		return view, err
	}
	defer rows.Close()
	for rows.Next() {
		rec, err := scanRequestRow(rows)
		if err != nil {
			return view, err
		}
		view.Turns = append(view.Turns, rec)
	}
	if err := rows.Err(); err != nil {
		return view, err
	}
	if len(view.Turns) > maxConversationTurns {
		view.Turns = view.Turns[:maxConversationTurns]
		view.Truncated = true
	}
	view.Totals = summarizeConversation(view.Turns)
	return view, nil
}

func summarizeConversation(turns []requestRecord) conversationTotals {
	totals := conversationTotals{Accounts: []string{}, Models: []string{}}
	seenAccount, seenModel := map[string]bool{}, map[string]bool{}
	lastAccount := ""
	for i, rec := range turns {
		totals.Requests++
		if rec.Success {
			totals.Successes++
		} else {
			totals.Failures++
		}
		if rec.ReplayOf > 0 {
			totals.Replays++
		}
		for _, a := range rec.Attempts {
			if a.Failover {
				totals.Failovers++
			}
		}
		totals.InTokens += rec.InTokens
		totals.OutTokens += rec.OutTokens
		totals.CacheRead += rec.CacheRead
		totals.Credits += rec.Credits
		totals.DurationMs += rec.DurationMs
		if i == 0 {
			totals.FirstTS = rec.TS
		}
		totals.LastTS = rec.TS
		account := rec.Email
		if account == "" {
			account = rec.AccountID
		}
		if account != "" {
			if !seenAccount[account] {
				seenAccount[account] = true
				totals.Accounts = append(totals.Accounts, account)
			}
			if lastAccount != "" && lastAccount != account {
				totals.AccountMove++
			}
			lastAccount = account
		}
		if rec.Model != "" && !seenModel[rec.Model] {
			seenModel[rec.Model] = true
			totals.Models = append(totals.Models, rec.Model)
		}
	}
	return totals
}

// apiConversation serves GET /admin/api/observe/conversations/{id}.
func (h *Handler) apiConversation(w http.ResponseWriter, id string) {
	id = strings.TrimSpace(id)
	view, err := loadConversation(id)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if id == "" || len(view.Turns) == 0 {
		writeAdminError(w, http.StatusNotFound, codeConversationMissing, "no request of this conversation is logged")
		return
	}
	json.NewEncoder(w).Encode(view)
}

func loadRequestRecord(id int64) (requestRecord, error) {
	d, err := db.Get()
	if err != nil {
		return requestRecord{}, err
	}
	return scanRequestRow(d.QueryRow(`SELECT `+requestColumns+` FROM requests WHERE id = ?`, id))
}

func parseRequestID(raw string) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	return id, err == nil && id > 0
}

// apiRequestBody serves GET /admin/api/observe/requests/{id}/body: the kept body
// with the client's key masked, for the replay dialog.
func (h *Handler) apiRequestBody(w http.ResponseWriter, rawID string) {
	id, ok := parseRequestID(rawID)
	if !ok {
		writeAdminError(w, http.StatusNotFound, codeRequestNotFound, "request not found")
		return
	}
	stored, err := loadRequestBody(id)
	if errors.Is(err, errRequestBodyMissing) {
		writeAdminError(w, http.StatusNotFound, codeRequestBodyMissing, err.Error())
		return
	}
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	var probe struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	_ = json.Unmarshal(stored.Body, &probe)
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"endpoint": stored.Endpoint,
		"size":     stored.Size,
		"model":    probe.Model,
		"stream":   probe.Stream,
		"body":     string(stored.Body),
	})
}

// replayRecorder collects a replayed request's answer in memory.
type replayRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *replayRecorder) Header() http.Header { return r.header }
func (r *replayRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}
func (r *replayRecorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	if room := maxReplayResponseBytes - r.body.Len(); room > 0 {
		if len(p) > room {
			r.body.Write(p[:room])
		} else {
			r.body.Write(p)
		}
	}
	return len(p), nil
}
func (r *replayRecorder) Flush() {}

func replayPath(endpoint string) (string, bool) {
	switch endpoint {
	case requestEndpointClaude:
		return "/v1/messages", true
	case requestEndpointOpenAI:
		return "/v1/chat/completions", true
	case requestEndpointResponses:
		return "/v1/responses", true
	}
	return "", false
}

// replayBody is the kept body with the chosen model and streaming off.
func replayBody(raw []byte, model string) ([]byte, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	if model != "" {
		quoted, _ := json.Marshal(model)
		body["model"] = quoted
	}
	body["stream"] = json.RawMessage("false")
	delete(body, "stream_options")
	return json.Marshal(body)
}

// apiReplayRequest serves POST /admin/api/observe/requests/{id}/replay with
// {"accountId": ..., "model": ...}: the kept body runs again on that account,
// without streaming, and is logged as a new request marked as a replay. It spends credits.
func (h *Handler) apiReplayRequest(w http.ResponseWriter, r *http.Request, rawID string) {
	id, ok := parseRequestID(rawID)
	if !ok {
		writeAdminError(w, http.StatusNotFound, codeRequestNotFound, "request not found")
		return
	}
	var req struct {
		AccountID string `json:"accountId"`
		Model     string `json:"model"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	original, err := loadRequestRecord(id)
	if err != nil {
		writeAdminError(w, http.StatusNotFound, codeRequestNotFound, "request not found")
		return
	}
	stored, err := loadRequestBody(id)
	if errors.Is(err, errRequestBodyMissing) {
		writeAdminError(w, http.StatusNotFound, codeRequestBodyMissing, err.Error())
		return
	}
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	accountID := strings.TrimSpace(req.AccountID)
	if accountID == "" {
		accountID = original.AccountID
	}
	account := findAccountByID(accountID)
	if account == nil {
		writeAdminError(w, http.StatusBadRequest, codeReplayAccount, "choose an account that exists")
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = original.Model
	}
	path, ok := replayPath(stored.Endpoint)
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeRequestBodyMissing, "this request's API cannot be replayed")
		return
	}
	body, err := replayBody(stored.Body, model)
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, codeRequestBodyMissing, "the kept body is not JSON")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), replayTimeout)
	defer cancel()
	inner, err := http.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(body))
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	inner.Header.Set("Content-Type", "application/json")
	for name, value := range stored.Headers {
		inner.Header.Set(name, value)
	}
	inner = withRequestTrace(inner, stored.Endpoint)
	trace := requestTraceFromContext(inner.Context())
	trace.requestID = newRequestID()
	trace.replayOf = id
	//! The replay may use only the chosen account: the same allowlist a bound API key sets.
	innerCtx := context.WithValue(inner.Context(), apiKeyContextKey{}, apiKeyContextValue{allowed: map[string]bool{account.ID: true}})
	inner = inner.WithContext(withRPMPicks(innerCtx, h.pool))
	captureRequestBody(inner)

	logger.Infof("[Admin] Replaying request #%d on %s with %s", id, accountEmailForLog(account), model)
	rec := &replayRecorder{header: http.Header{}}
	switch stored.Endpoint {
	case requestEndpointClaude:
		h.handleClaudeMessages(rec, inner)
	case requestEndpointOpenAI:
		h.handleOpenAIChat(rec, inner)
	case requestEndpointResponses:
		h.handleOpenAIResponses(rec, inner)
	}
	status := rec.status
	if status == 0 {
		status = http.StatusOK
	}
	out := map[string]any{
		"status":      status,
		"contentType": rec.header.Get("Content-Type"),
		"durationMs":  trace.durationMs(),
		"accountId":   account.ID,
		"model":       model,
	}
	if json.Valid(rec.body.Bytes()) {
		out["response"] = json.RawMessage(rec.body.Bytes())
	} else {
		out["responseText"] = rec.body.String()
	}
	if trace.loggedID > 0 {
		if logged, err := loadRequestRecord(trace.loggedID); err == nil {
			out["request"] = logged
		}
	}
	json.NewEncoder(w).Encode(out)
}
