package proxy

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

const (
	// userSessionTTL matches the admin session: a stolen token stops working on its own.
	userSessionTTL = adminSessionTTL
	// maxUserSessions caps memory growth from repeated sign-ins over every key.
	maxUserSessions = 1024
	// maxUserSessionsPerKey keeps one key's sign-in loop from signing other keys out.
	maxUserSessionsPerKey = 16
	// maxUserRequestsPageSize bounds one page of GET /user/api/requests.
	maxUserRequestsPageSize = 100
	// userUsageCacheTTL is how long a key's usage answer is reused. The usage queries read every
	// key's rows (all of them for "all"), and a key holder's page or script may ask in a loop.
	userUsageCacheTTL = 30 * time.Second
	// userUsageBuildsPerMinute caps the usage queries one key may run past the cache: another
	// range or time zone is another answer, so the cache alone cannot bound a loop.
	userUsageBuildsPerMinute = 20
)

// errUserUsageBusy is a key over userUsageBuildsPerMinute; it is answered 429.
var errUserUsageBusy = errors.New("too many usage queries for this key")

// userUsageCache keeps each key's recent usage answers, by key, route and window, runs one query
// per answer at a time, and holds each key to userUsageBuildsPerMinute queries. The zero value
// is ready to use.
type userUsageCache struct {
	mu       sync.Mutex
	entries  map[string]userUsageCacheEntry
	inflight map[string]chan struct{}
	budgets  map[string]adminGuessBucket
}

type userUsageCacheEntry struct {
	at   time.Time
	body []byte
}

// get returns keyID's encoded answer for id, building it at most once per userUsageCacheTTL.
// A request for an answer that is being built waits for it. Expired answers and spent budgets
// are dropped whenever a new answer is stored, so the maps stay small.
func (c *userUsageCache) get(keyID, id string, build func() (any, error)) ([]byte, error) {
	for {
		now := time.Now()
		c.mu.Lock()
		if e, ok := c.entries[id]; ok && now.Sub(e.at) < userUsageCacheTTL {
			c.mu.Unlock()
			return e.body, nil
		}
		if wait, ok := c.inflight[id]; ok {
			c.mu.Unlock()
			<-wait
			continue
		}
		if c.inflight == nil {
			c.inflight = make(map[string]chan struct{})
			c.budgets = make(map[string]adminGuessBucket)
			c.entries = make(map[string]userUsageCacheEntry)
		}
		budget := c.budgets[keyID]
		if !now.Before(budget.until) {
			budget = adminGuessBucket{until: now.Add(time.Minute)}
		}
		if budget.count >= userUsageBuildsPerMinute {
			c.mu.Unlock()
			return nil, errUserUsageBusy
		}
		budget.count++
		c.budgets[keyID] = budget
		done := make(chan struct{})
		c.inflight[id] = done
		c.mu.Unlock()
		return c.build(id, done, now, build)
	}
}

// build runs one query for id and stores its answer. The waiters are released even if the
// query panics, so a failed answer is tried again rather than waited on forever.
func (c *userUsageCache) build(id string, done chan struct{}, now time.Time, build func() (any, error)) (body []byte, err error) {
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		delete(c.inflight, id)
		close(done)
		if err != nil || body == nil {
			return
		}
		for k, e := range c.entries {
			if now.Sub(e.at) >= userUsageCacheTTL {
				delete(c.entries, k)
			}
		}
		for k, b := range c.budgets {
			if !now.Before(b.until) {
				delete(c.budgets, k)
			}
		}
		c.entries[id] = userUsageCacheEntry{at: now, body: body}
	}()
	v, err := build()
	if err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

// writeUserInternalError logs err and answers 500 without its text: a database or I/O error can
// name files and internals a key holder has no business seeing. A key over its usage budget gets
// 429 with a minute to wait.
func writeUserInternalError(w http.ResponseWriter, err error) {
	if errors.Is(err, errUserUsageBusy) {
		w.Header().Set("Retry-After", "60")
		writeAdminError(w, http.StatusTooManyRequests, codeUserUsageBusy, "Too many usage requests; try again in a minute")
		return
	}
	logger.Warnf("[UserPanel] %v", err)
	writeAdminError(w, http.StatusInternalServerError, codeInternalError, "Internal error")
}

// userSession is one signed-in key holder. keyHash is the key's value at sign-in, so a
// regenerated key ends the session.
type userSession struct {
	keyID   string
	keyHash [sha256.Size]byte
	expiry  time.Time
}

// userSessionStore holds the user panel's sessions. The zero value is ready to use.
type userSessionStore struct {
	mu       sync.Mutex
	sessions map[string]userSession
}

func (s *userSessionStore) pruneLocked(now time.Time) {
	for token, session := range s.sessions {
		if now.After(session.expiry) {
			delete(s.sessions, token)
		}
	}
}

// evictOldestLocked drops the session that expires first among those match accepts.
func (s *userSessionStore) evictOldestLocked(match func(userSession) bool) {
	oldest, oldestExpiry := "", time.Time{}
	for token, session := range s.sessions {
		if match(session) && (oldest == "" || session.expiry.Before(oldestExpiry)) {
			oldest, oldestExpiry = token, session.expiry
		}
	}
	delete(s.sessions, oldest)
}

// issue mints a session for entry. The caller must have already checked the key's value.
func (s *userSessionStore) issue(entry config.ApiKeyEntry) (string, time.Time, error) {
	token, err := newSecret()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now()
	session := userSession{keyID: entry.ID, keyHash: sha256.Sum256([]byte(entry.Key)), expiry: now.Add(userSessionTTL)}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions == nil {
		s.sessions = make(map[string]userSession)
	}
	s.pruneLocked(now)
	//! Oldest-first eviction, within the key first, keeps a sign-in loop from pinning memory.
	sameKey := func(other userSession) bool { return other.keyID == entry.ID }
	perKey := 0
	for _, other := range s.sessions {
		if sameKey(other) {
			perKey++
		}
	}
	if perKey >= maxUserSessionsPerKey {
		s.evictOldestLocked(sameKey)
	}
	if len(s.sessions) >= maxUserSessions {
		s.evictOldestLocked(func(userSession) bool { return true })
	}
	s.sessions[token] = session
	return token, session.expiry, nil
}

// key returns the API key token's session belongs to. A session past its expiry, or whose key
// was deleted or given a new value, ends here.
func (s *userSessionStore) key(token string) (config.ApiKeyEntry, bool) {
	if token == "" {
		return config.ApiKeyEntry{}, false
	}
	s.mu.Lock()
	session, ok := s.sessions[token]
	s.mu.Unlock()
	if !ok {
		return config.ApiKeyEntry{}, false
	}
	entry := config.GetApiKeyEntry(session.keyID)
	if entry != nil && !time.Now().After(session.expiry) {
		sum := sha256.Sum256([]byte(entry.Key))
		if subtle.ConstantTimeCompare(sum[:], session.keyHash[:]) == 1 {
			return *entry, true
		}
	}
	s.revoke(token)
	return config.ApiKeyEntry{}, false
}

func (s *userSessionStore) revoke(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}

// findUserKey returns the configured key whose value is value. It compares the hashes of every
// key's value in constant time, so the time taken says nothing about how close a guess came.
func findUserKey(value string) (config.ApiKeyEntry, bool) {
	sum := sha256.Sum256([]byte(value))
	var match config.ApiKeyEntry
	found := false
	for _, entry := range config.ListApiKeys() {
		other := sha256.Sum256([]byte(entry.Key))
		if subtle.ConstantTimeCompare(sum[:], other[:]) == 1 && entry.ID != "" {
			match, found = entry, true
		}
	}
	return match, found
}

// handleUserAPI serves /user/api/*: the self-service panel of one API key's holder. It shows
// only that key, never accounts, other keys, routing or request bodies.
func (h *Handler) handleUserAPI(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/user/api")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if path == "/session" && r.Method == http.MethodPost {
		h.apiCreateUserSession(w, r)
		return
	}
	token := r.Header.Get("X-User-Token")
	entry, ok := h.userSessions.key(token)
	//! The request and usage filters take the key's ID; an empty one would match every key's rows.
	if !ok || strings.TrimSpace(entry.ID) == "" {
		writeAdminError(w, http.StatusUnauthorized, codeUserSessionExpired, "Unauthorized")
		return
	}
	switch {
	case path == "/session" && r.Method == http.MethodDelete:
		h.userSessions.revoke(token)
		w.WriteHeader(http.StatusNoContent)
	case path == "/key" && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(toUserKeyView(entry))
	case path == "/usage" && r.Method == http.MethodGet:
		apiUserUsage(w, r, entry, &h.userUsage)
	case path == "/usage/breakdown" && r.Method == http.MethodGet:
		apiUserUsageBreakdown(w, r, entry, &h.userUsage)
	case path == "/requests" && r.Method == http.MethodGet:
		apiUserRequests(w, r, entry)
	default:
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
	}
}

// apiCreateUserSession exchanges an API key's value for a session token. Every configured key
// may sign in, enabled, expired or not, so its holder can see why requests fail. Failures
// draw on their own lockout, answered as the admin sign-in's is.
func (h *Handler) apiCreateUserSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req)
	value := strings.TrimSpace(req.Key)
	if value == "" {
		writeAdminError(w, http.StatusBadRequest, codeUserKeyRequired, "Enter an API key")
		return
	}
	var entry config.ApiKeyEntry
	valid, delay := h.userGuesses.check(adminRemoteHost(r), time.Now(), func() bool {
		var found bool
		entry, found = findUserKey(value)
		return found
	})
	if delay > 0 {
		writeGuessLimited(w, delay, "Too many API key attempts; try again later")
		return
	}
	if !valid {
		writeAdminError(w, http.StatusUnauthorized, codeUserKeyInvalid, "Invalid API key")
		return
	}
	token, expiry, err := h.userSessions.issue(entry)
	if err != nil {
		writeUserInternalError(w, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token":     token,
		"expiresAt": expiry.Unix(),
	})
}

// userKeyView is the part of apiKeyView a key's holder sees. Every field is always sent; 0
// means unlimited or never.
type userKeyView struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	KeyMasked       string   `json:"keyMasked"`
	Enabled         bool     `json:"enabled"`
	Expired         bool     `json:"expired"`
	CreatedAt       int64    `json:"createdAt"`
	LastUsedAt      int64    `json:"lastUsedAt"`
	ExpiresAt       int64    `json:"expiresAt"`
	TokenLimit      int64    `json:"tokenLimit"`
	TokensUsed      int64    `json:"tokensUsed"`
	CreditLimit     float64  `json:"creditLimit"`
	CreditsUsed     float64  `json:"creditsUsed"`
	CallLimit       int64    `json:"callLimit"`
	SuccessfulCalls int64    `json:"successfulCalls"`
	RequestsCount   int64    `json:"requestsCount"`
	RPMLimit        int      `json:"rpmLimit"`
	AllowedModels   []string `json:"allowedModels"`
	// KeysRequired is the server's "Require API key". Off, calls to its own address are not
	// checked for a key, so they count for no key; calls through the public link always are.
	KeysRequired bool `json:"keysRequired"`
}

func toUserKeyView(entry config.ApiKeyEntry) userKeyView {
	v := toApiKeyView(entry)
	return userKeyView{
		ID:              v.ID,
		Name:            v.Name,
		KeyMasked:       v.KeyMasked,
		Enabled:         v.Enabled,
		Expired:         v.Expired,
		CreatedAt:       v.CreatedAt,
		LastUsedAt:      v.LastUsedAt,
		ExpiresAt:       v.ExpiresAt,
		TokenLimit:      v.TokenLimit,
		TokensUsed:      v.TokensUsed,
		CreditLimit:     v.CreditLimit,
		CreditsUsed:     v.CreditsUsed,
		CallLimit:       v.CallLimit,
		SuccessfulCalls: v.SuccessfulCalls,
		RequestsCount:   v.RequestsCount,
		RPMLimit:        v.RPMLimit,
		AllowedModels:   v.AllowedModels,
		KeysRequired:    config.IsApiKeyRequired(),
	}
}

// parseUserUsageWindow reads ?range= and ?tzOffset= as the admin usage routes do, and answers
// their 400 when one is invalid.
func parseUserUsageWindow(w http.ResponseWriter, r *http.Request) (usageRange, int, bool) {
	q := r.URL.Query()
	rng, ok := parseUsageRange(q.Get("range"))
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeInvalidUsageRange, "range must be 24h, 7d, 30d or all")
		return usageRange{}, 0, false
	}
	tz, ok := parseTZOffset(q.Get("tzOffset"))
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeInvalidTZOffset, "tzOffset must be whole minutes between -840 and 840")
		return usageRange{}, 0, false
	}
	return rng, tz, true
}

// apiUserUsage serves GET /user/api/usage: the admin usage response with only this key's entry,
// whose totals become the response's. A key without traffic gets an empty entry.
func apiUserUsage(w http.ResponseWriter, r *http.Request, entry config.ApiKeyEntry, cache *userUsageCache) {
	rng, tz, ok := parseUserUsageWindow(w, r)
	if !ok {
		return
	}
	body, err := cache.get(entry.ID, fmt.Sprintf("usage|%s|%s|%d", entry.ID, rng.name, tz), func() (any, error) {
		return userUsage(rng, tz, entry)
	})
	if err != nil {
		writeUserInternalError(w, err)
		return
	}
	_, _ = w.Write(body)
}

// userUsage is the admin usage response for rng with only entry's row in it.
func userUsage(rng usageRange, tz int, entry config.ApiKeyEntry) (apiKeyUsageResponse, error) {
	resp, err := queryApiKeyUsage(observeNow(), rng, tz, config.ListApiKeys())
	if err != nil {
		return resp, err
	}
	own := apiKeyUsageEntry{
		ID:        entry.ID,
		Kind:      usageKindKey,
		Name:      entry.Name,
		KeyMasked: config.MaskApiKey(entry.Key),
		Series:    make([]apiKeyUsageTotals, len(resp.Buckets)),
	}
	for _, e := range resp.Keys {
		if e.Kind == usageKindKey && e.ID == entry.ID {
			own = e
		}
	}
	resp.Keys = []apiKeyUsageEntry{own}
	resp.Totals = own.Totals
	resp.Earlier = own.Earlier
	return resp, nil
}

// apiUserUsageBreakdown serves GET /user/api/usage/breakdown: this key's usage by model. The
// accounts that served it stay hidden.
func apiUserUsageBreakdown(w http.ResponseWriter, r *http.Request, entry config.ApiKeyEntry, cache *userUsageCache) {
	rng, tz, ok := parseUserUsageWindow(w, r)
	if !ok {
		return
	}
	body, err := cache.get(entry.ID, fmt.Sprintf("breakdown|%s|%s|%d", entry.ID, rng.name, tz), func() (any, error) {
		resp, err := queryApiKeyUsageBreakdown(observeNow(), rng, tz, config.ListApiKeys(), usageKindKey+":"+entry.ID)
		resp.Accounts = []usageBreakdownItem{}
		return resp, err
	})
	if err != nil {
		writeUserInternalError(w, err)
		return
	}
	_, _ = w.Write(body)
}

// userRequestView is one request log row as its key's holder sees it: no account, message,
// attempts, conversation or body.
type userRequestView struct {
	TS               int64   `json:"ts"`
	Model            string  `json:"model"`
	Endpoint         string  `json:"endpoint"`
	InTokens         int     `json:"inTokens"`
	OutTokens        int     `json:"outTokens"`
	TotalTokens      int     `json:"totalTokens"`
	CacheReadTokens  int     `json:"cacheReadTokens"`
	CacheWriteTokens int     `json:"cacheWriteTokens"`
	Credits          float64 `json:"credits"`
	Success          bool    `json:"success"`
	Status           int     `json:"status"`
	DurationMs       int64   `json:"durationMs"`
	ErrorType        string  `json:"errorType"`
	RequestID        string  `json:"requestId"`
}

// apiUserRequests serves GET /user/api/requests?page=&pageSize=&status=all|success|error:
// this key's requests, newest first, from the same log as the admin Requests page.
func apiUserRequests(w http.ResponseWriter, r *http.Request, entry config.ApiKeyEntry) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, err := strconv.Atoi(q.Get("pageSize"))
	if err != nil || pageSize < 1 {
		pageSize = 25
	}
	pageSize = min(pageSize, maxUserRequestsPageSize)
	status := ""
	switch q.Get("status") {
	case "success":
		status = "success"
	case "error":
		status = "failed"
	}
	data := getObserveStore().RequestPage(requestQuery{Page: page, PageSize: pageSize, Status: status, APIKeyID: entry.ID})
	requests := make([]userRequestView, len(data.Requests))
	for i, rec := range data.Requests {
		requests[i] = userRequestView{
			TS:               rec.TS,
			Model:            rec.Model,
			Endpoint:         rec.Endpoint,
			InTokens:         rec.InTokens,
			OutTokens:        rec.OutTokens,
			TotalTokens:      rec.TotalTokens,
			CacheReadTokens:  rec.CacheRead,
			CacheWriteTokens: rec.CacheWrite,
			Credits:          rec.Credits,
			Success:          rec.Success,
			Status:           rec.Status,
			DurationMs:       rec.DurationMs,
			ErrorType:        rec.ErrorType,
			RequestID:        rec.RequestID,
		}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"requests": requests,
		"total":    data.Total,
		"page":     data.Page,
		"pageSize": data.PageSize,
	})
}
