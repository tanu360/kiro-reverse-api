package proxy

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
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
	// userRequestPagesPerMinute caps the request pages one key may read in a minute. Pages are not
	// cached, so a poll sees new requests at once; the panel polls the page in view every 30 s
	// and a person pages and sorts by hand, both far below this.
	userRequestPagesPerMinute = 60
	// maxUserRequestsRows is how deep GET /user/api/requests reads: page*pageSize stays at most
	// this, so no page has the database sort and step over more of the key's rows than that.
	maxUserRequestsRows = 10000
)

// errUserUsageBusy is a key over userUsageBuildsPerMinute or userRequestPagesPerMinute; it is
// answered 429.
var errUserUsageBusy = errors.New("too many usage queries for this key")

// userUsageCache keeps each key's recent usage answers, by key, route and window, runs one query
// per answer at a time, and holds each key to userUsageBuildsPerMinute queries. It also holds
// each key to userRequestPagesPerMinute request pages (spendRequestPage). The zero value is
// ready to use.
type userUsageCache struct {
	mu       sync.Mutex
	entries  map[string]userUsageCacheEntry
	inflight map[string]chan struct{}
	budgets  map[string]adminGuessBucket
	// pageBudgets are the request pages' budgets, apart from the usage queries' so that paging
	// through requests never holds back the usage charts, nor the other way round.
	pageBudgets map[string]adminGuessBucket
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
		if !spendBudgetLocked(c.budgets, keyID, userUsageBuildsPerMinute, now) {
			c.mu.Unlock()
			return nil, errUserUsageBusy
		}
		done := make(chan struct{})
		c.inflight[id] = done
		c.mu.Unlock()
		return c.build(id, done, now, build)
	}
}

// spendBudgetLocked counts one query against keyID's bucket in budgets, a fresh bucket each
// minute, and reports false, counting nothing, once the key has run limit queries in its
// minute. The cache's mu must be held.
func spendBudgetLocked(budgets map[string]adminGuessBucket, keyID string, limit int, now time.Time) bool {
	budget := budgets[keyID]
	if !now.Before(budget.until) {
		budget = adminGuessBucket{until: now.Add(time.Minute)}
	}
	if budget.count >= limit {
		return false
	}
	budget.count++
	budgets[keyID] = budget
	return true
}

// spendRequestPage counts one GET /user/api/requests against keyID's userRequestPagesPerMinute
// and answers errUserUsageBusy once they are spent. Spent budgets are dropped whenever a key
// starts a new minute, so the map stays small.
func (c *userUsageCache) spendRequestPage(keyID string) error {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pageBudgets == nil {
		c.pageBudgets = make(map[string]adminGuessBucket)
	}
	if !now.Before(c.pageBudgets[keyID].until) {
		for k, b := range c.pageBudgets {
			if !now.Before(b.until) {
				delete(c.pageBudgets, k)
			}
		}
	}
	if !spendBudgetLocked(c.pageBudgets, keyID, userRequestPagesPerMinute, now) {
		return errUserUsageBusy
	}
	return nil
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
// name files and internals a key holder has no business seeing. A key over its usage or request
// page budget gets 429 with a minute to wait.
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

// userSessionHandoff is one key holder's session carried across a restart into an update.
type userSessionHandoff struct {
	Token   string    `json:"token"`
	KeyID   string    `json:"keyId"`
	KeyHash string    `json:"keyHash"`
	Expires time.Time `json:"expires"`
}

// Export returns the unexpired sessions as JSON, or nil when there are none, so the process a
// self-update restarts into keeps key holders signed in as it keeps the admin.
func (s *userSessionStore) Export() []byte {
	now := time.Now()
	s.mu.Lock()
	s.pruneLocked(now)
	list := make([]userSessionHandoff, 0, len(s.sessions))
	for token, session := range s.sessions {
		list = append(list, userSessionHandoff{
			Token:   token,
			KeyID:   session.keyID,
			KeyHash: hex.EncodeToString(session.keyHash[:]),
			Expires: session.expiry,
		})
	}
	s.mu.Unlock()
	if len(list) == 0 {
		return nil
	}
	data, err := json.Marshal(list)
	if err != nil {
		return nil
	}
	return data
}

// Import adds the sessions Export wrote and returns how many it kept: unexpired ones, none
// outliving the TTL it was issued with, within both caps. A session whose key was deleted or
// changed in the meantime ends on its next request, as any other.
func (s *userSessionStore) Import(data []byte) int {
	var list []userSessionHandoff
	if err := json.Unmarshal(data, &list); err != nil {
		return 0
	}
	now := time.Now()
	latest := now.Add(userSessionTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions == nil {
		s.sessions = make(map[string]userSession)
	}
	s.pruneLocked(now)
	perKey := make(map[string]int)
	for _, session := range s.sessions {
		perKey[session.keyID]++
	}
	kept := 0
	for _, entry := range list {
		hash, err := hex.DecodeString(entry.KeyHash)
		if err != nil || len(hash) != sha256.Size || entry.KeyID == "" || entry.Token == "" ||
			len(entry.Token) > maxHandoffTokenLen || !entry.Expires.After(now) {
			continue
		}
		if len(s.sessions) >= maxUserSessions {
			break
		}
		if perKey[entry.KeyID] >= maxUserSessionsPerKey {
			continue
		}
		session := userSession{keyID: entry.KeyID, expiry: entry.Expires}
		if session.expiry.After(latest) {
			session.expiry = latest
		}
		copy(session.keyHash[:], hash)
		s.sessions[entry.Token] = session
		perKey[entry.KeyID]++
		kept++
	}
	return kept
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

// isUserAPIPath reports whether path belongs to the user panel's API. The bare root is one of
// its routes too, so it answers JSON without the inference API's CORS headers.
func isUserAPIPath(path string) bool {
	return path == "/user/api" || strings.HasPrefix(path, "/user/api/")
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
		apiUserRequests(w, r, entry, &h.userUsage)
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

// userUsageResponse is the admin usage response for one key, with the stretch before its window
// to compare against.
type userUsageResponse struct {
	apiKeyUsageResponse
	// Previous is the key's usage over the stretch before the window (userUsagePrevious); nil
	// for all time, which has nothing before it.
	Previous *apiKeyUsageTotals `json:"previous,omitempty"`
}

// userUsage is the admin usage response for rng with only entry's row in it, and the stretch
// before it.
func userUsage(rng usageRange, tz int, entry config.ApiKeyEntry) (userUsageResponse, error) {
	now := observeNow()
	keys := config.ListApiKeys()
	resp, err := queryApiKeyUsage(now, rng, tz, keys)
	if err != nil {
		return userUsageResponse{apiKeyUsageResponse: resp}, err
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
	previous, err := userUsagePrevious(now, rng, tz, keys, entry)
	return userUsageResponse{apiKeyUsageResponse: resp, Previous: previous}, err
}

// userUsagePrevious is entry's usage over the stretch just before rng's window, as long as the
// part of the window that has passed: the window runs from its first bucket to now, so the
// stretch is [from-span, now-span] for a window of span seconds. Equal stretches, as the Overview
// compares the last hour with the hour before, keep a window whose last bucket has just begun from
// reading as a fall. Rows log retention pruned count from their day's totals, in proportion to the
// part of that day the stretch covers. All time has no stretch before it: nil.
func userUsagePrevious(now time.Time, rng usageRange, tz int, keys []config.ApiKeyEntry, entry config.ApiKeyEntry) (*apiKeyUsageTotals, error) {
	if rng.name == usageRangeAll {
		return nil, nil
	}
	span := rng.bucketSec * int64(rng.buckets)
	off := int64(tz) * 60
	from := ((now.Unix()+off)/rng.bucketSec-int64(rng.buckets)+1)*rng.bucketSec - off
	start, end := from-span, now.Unix()+1-span

	d, err := db.Read()
	if err != nil {
		return nil, err
	}
	//! One transaction: a prune between the log and the rollup reads would count a row twice or
	//! miss it.
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	c := newUsageCollector(keys, 1)
	slot, slotArgs := usageSlotSQL(keys)
	rows, err := tx.Query(`SELECT
api_key_id,
`+slot+` AS slot,
COUNT(*),
COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(in_tokens), 0),
COALESCE(SUM(out_tokens), 0),
COALESCE(SUM(credits), 0)
FROM requests
WHERE ts >= ? AND ts < ?
GROUP BY api_key_id, slot`, append(slotArgs, start, end)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var (
			keyID string
			slot  int
			t     apiKeyUsageTotals
		)
		if err := rows.Scan(&keyID, &slot, &t.Requests, &t.Succeeded, &t.InTokens, &t.OutTokens, &t.Credits); err != nil {
			rows.Close()
			return nil, err
		}
		c.add(c.entry(keyID, slot), 0, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Retention prunes the oldest rows first, so every pruned row is older than the oldest one
	// left: a stretch that starts at or after it has nothing pruned in it.
	var oldest sql.NullInt64
	if err := tx.QueryRow(`SELECT MIN(ts) FROM requests`).Scan(&oldest); err != nil {
		return nil, err
	}
	if !oldest.Valid || oldest.Int64 > start {
		err := scanRollupUsageDays(tx, floorDiv(start, daySeconds), floorDiv(end-1, daySeconds), func(day int64, keyID string, keyless bool, t apiKeyUsageTotals) {
			// A pruned day's rows lie in its UTC day, before the oldest row the log still has.
			dayStart, dayEnd := day*daySeconds, (day+1)*daySeconds
			if oldest.Valid && oldest.Int64 > dayStart && oldest.Int64 < dayEnd {
				dayEnd = oldest.Int64
			}
			covered := min(end, dayEnd) - max(start, dayStart)
			if covered <= 0 {
				return
			}
			c.add(c.entry(keyID, rollupUsageSlot(keyID, keyless)), 0, scaleUsageTotals(t, float64(covered)/float64(dayEnd-dayStart)))
		})
		if err != nil {
			return nil, err
		}
	}

	previous := apiKeyUsageTotals{}
	if e, ok := c.entries[usageKindKey+":"+entry.ID]; ok {
		previous = e.Totals
	}
	return &previous, nil
}

// scaleUsageTotals is share of t, counts rounded; a share of 1 or more is t itself.
func scaleUsageTotals(t apiKeyUsageTotals, share float64) apiKeyUsageTotals {
	if share >= 1 {
		return t
	}
	scale := func(n int64) int64 { return int64(math.Round(float64(n) * share)) }
	return apiKeyUsageTotals{
		Requests:  scale(t.Requests),
		Succeeded: scale(t.Succeeded),
		InTokens:  scale(t.InTokens),
		OutTokens: scale(t.OutTokens),
		Credits:   t.Credits * share,
	}
}

// userUsageBreakdown is the admin breakdown of one key with who called it added: a coding tool,
// else the client API, else "other" (usageClient).
type userUsageBreakdown struct {
	apiKeyUsageBreakdown
	Clients []usageBreakdownItem `json:"clients"`
}

// apiUserUsageBreakdown serves GET /user/api/usage/breakdown: this key's usage by model and by
// client. The accounts that served it stay hidden.
func apiUserUsageBreakdown(w http.ResponseWriter, r *http.Request, entry config.ApiKeyEntry, cache *userUsageCache) {
	rng, tz, ok := parseUserUsageWindow(w, r)
	if !ok {
		return
	}
	body, err := cache.get(entry.ID, fmt.Sprintf("breakdown|%s|%s|%d", entry.ID, rng.name, tz), func() (any, error) {
		resp, clients, err := queryUsageBreakdown(observeNow(), rng, tz, config.ListApiKeys(), usageKindKey+":"+entry.ID)
		resp.Accounts = []usageBreakdownItem{}
		return userUsageBreakdown{apiKeyUsageBreakdown: resp, Clients: clients}, err
	})
	if err != nil {
		writeUserInternalError(w, err)
		return
	}
	_, _ = w.Write(body)
}

// userRequestView is one request log row as its key's holder sees it: no account, message,
// conversation or body, and of the attempts only how many there were.
type userRequestView struct {
	TS               int64   `json:"ts"`
	Model            string  `json:"model"`
	Endpoint         string  `json:"endpoint"`
	Client           string  `json:"client"`
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
	// Tries is the number of upstream attempts the request took (0 when it was refused before
	// one); never which accounts served them.
	Tries int `json:"tries"`
}

// userRequestFromRecord is rec as its key's holder may see it. The persisted and in-memory logs
// both keep the attempt chain on the record, so either gives the same count.
func userRequestFromRecord(rec requestRecord) userRequestView {
	return userRequestView{
		TS:               rec.TS,
		Model:            rec.Model,
		Endpoint:         rec.Endpoint,
		Client:           rec.Client,
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
		Tries:            attemptCount(rec.Attempts),
	}
}

// userRequestSorts are the admin Requests sorts a key's holder may use. Account and API key are
// left out: one key's rows ordered by account would show how its accounts' emails sort.
var userRequestSorts = map[string]bool{
	"time": true, "status": true, "model": true, "tokens": true, "credits": true, "duration": true,
}

// userRequestCounts are a key's requests per status tab, whatever the page shows.
type userRequestCounts struct {
	All       int `json:"all"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

// countUserRequests is the number of keyID's requests with status ("success" or "failed").
func countUserRequests(keyID, status string) int {
	return getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 1, Status: status, APIKeyID: keyID}).Total
}

// apiUserRequests serves GET /user/api/requests?page=&pageSize=&status=all|success|error
// &sort=&order=asc|desc: this key's requests from the same log as the admin Requests page,
// newest first by default, with the key's count per status. An unknown or account sort is time.
// A page past maxUserRequestsRows is the last page within it.
func apiUserRequests(w http.ResponseWriter, r *http.Request, entry config.ApiKeyEntry, cache *userUsageCache) {
	//! Every page runs three queries that read and sort all of the key's rows on the database's
	//! one connection, and a disabled or expired key still signs in: an unbudgeted loop over
	//! pages would stall request logging and the admin pages.
	if err := cache.spendRequestPage(entry.ID); err != nil {
		writeUserInternalError(w, err)
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, err := strconv.Atoi(q.Get("pageSize"))
	if err != nil || pageSize < 1 {
		pageSize = 25
	}
	pageSize = min(pageSize, maxUserRequestsPageSize)
	// Clamped as normalizeRequestQuery clamps a page whose offset would overflow.
	page = min(page, maxUserRequestsRows/pageSize)
	status := ""
	switch q.Get("status") {
	case "success":
		status = "success"
	case "error":
		status = "failed"
	}
	sortBy := "time"
	if s := strings.ToLower(strings.TrimSpace(q.Get("sort"))); userRequestSorts[s] {
		sortBy = s
	}
	order := "desc"
	if strings.EqualFold(strings.TrimSpace(q.Get("order")), "asc") {
		order = "asc"
	}
	data := getObserveStore().RequestPageContext(r.Context(), requestQuery{Page: page, PageSize: pageSize, Status: status, Sort: sortBy, Order: order, APIKeyID: entry.ID})
	// The page's own total is one of the counts, so the tab in view always matches the pager.
	var counts userRequestCounts
	switch status {
	case "success":
		counts.Succeeded = data.Total
		counts.Failed = countUserRequests(entry.ID, "failed")
	case "failed":
		counts.Succeeded = countUserRequests(entry.ID, "success")
		counts.Failed = data.Total
	default:
		counts.Succeeded = countUserRequests(entry.ID, "success")
		counts.Failed = max(0, data.Total-counts.Succeeded)
	}
	counts.All = counts.Succeeded + counts.Failed
	requests := make([]userRequestView, len(data.Requests))
	for i, rec := range data.Requests {
		requests[i] = userRequestFromRecord(rec)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"requests": requests,
		"total":    data.Total,
		"page":     data.Page,
		"pageSize": data.PageSize,
		"sort":     data.Sort,
		"order":    data.Order,
		"counts":   counts,
	})
}
