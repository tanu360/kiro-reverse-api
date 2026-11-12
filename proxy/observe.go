package proxy

import (
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

const (
	observeMinuteSlots = 1440
	observeRecentErrs  = 100
	observeRecentReqs  = 200
	// observeSeriesMin is how many minutes the overview series carry.
	observeSeriesMin = 30
	// observeTopRankMin is the window, in minutes, that ranks accounts for top=N.
	observeTopRankMin = 60
)

// observeNow is the store's clock. Tests pin it so a minute boundary cannot
// fall between recording and asserting.
var observeNow = time.Now

// cacheTokenCounts splits out the prompt-cache share of a request's input
// tokens. Both counts are subsets of the input total, never added to it.
type cacheTokenCounts struct {
	Read  int
	Write int
}

// minuteBucket holds one minute of traffic. Reqs, Successes and Failures count
// final client requests, the same rows the request log keeps. Retries counts
// upstream attempts that failed, so one request that failed over twice and
// then succeeded is Reqs 1, Successes 1, Retries 2.
type minuteBucket struct {
	WindowMin        int64
	Reqs             int
	Successes        int
	Failures         int
	Retries          int
	InTokens         int64
	OutTokens        int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	Credits          float64
}

type modelStat struct {
	Reqs             int64
	Retries          int64
	InTokens         int64
	OutTokens        int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	Credits          float64
	LastUsed         int64
}

type errorRecord struct {
	TS        int64  `json:"ts"`
	AccountID string `json:"accountId"`
	Email     string `json:"email,omitempty"`
	Model     string `json:"model,omitempty"`
	Status    int    `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
}

type requestRecord struct {
	ID           int64   `json:"id,omitempty"`
	TS           int64   `json:"ts"`
	AccountID    string  `json:"accountId"`
	APIKeyID     string  `json:"apiKeyId,omitempty"`
	APIKey       string  `json:"-"`
	APIKeyMasked string  `json:"apiKeyMasked,omitempty"`
	Email        string  `json:"email,omitempty"`
	Model        string  `json:"model"`
	InTokens     int     `json:"inTokens"`
	OutTokens    int     `json:"outTokens"`
	TotalTokens  int     `json:"totalTokens"`
	CacheRead    int     `json:"cacheReadTokens"`
	CacheWrite   int     `json:"cacheWriteTokens"`
	Credits      float64 `json:"credits"`
	Success      bool    `json:"success"`
	Status       int     `json:"status,omitempty"`
	Message      string  `json:"message,omitempty"`
	Endpoint     string  `json:"endpoint,omitempty"`
	DurationMs   int64   `json:"durationMs,omitempty"`
	ErrorType    string  `json:"errorType,omitempty"`
}

type requestQuery struct {
	Page     int
	PageSize int
	Search   string
	Status   string
	Sort     string
	Order    string
}

type requestPage struct {
	Requests   []requestRecord `json:"requests"`
	Total      int             `json:"total"`
	Page       int             `json:"page"`
	PageSize   int             `json:"pageSize"`
	Sort       string          `json:"sort"`
	Order      string          `json:"order"`
	Persistent bool            `json:"persistent"`
}

type observeStore struct {
	mu             sync.RWMutex
	startedAt      int64
	globalRing     [observeMinuteSlots]minuteBucket
	accountRings   map[string]*[observeMinuteSlots]minuteBucket
	modelStats     map[string]*modelStat
	recentErrors   []errorRecord
	recentErrIdx   int
	recentRequests []requestRecord
	recentReqIdx   int
	maxAccountRing int
	accountTouched map[string]int64
	// generation counts resets, so a late model warmup can tell it is stale.
	generation uint64
	// seq goes up on every change to the store, so the tick can skip idle seconds.
	seq atomic.Uint64
}

var (
	observeStoreOnce sync.Once
	observeStoreInst *observeStore
)

func getObserveStore() *observeStore {
	observeStoreOnce.Do(func() {
		observeStoreInst = &observeStore{
			startedAt:      observeNow().Unix(),
			accountRings:   make(map[string]*[observeMinuteSlots]minuteBucket),
			modelStats:     make(map[string]*modelStat),
			recentErrors:   make([]errorRecord, observeRecentErrs),
			recentRequests: make([]requestRecord, observeRecentReqs),
			maxAccountRing: 200,
			accountTouched: make(map[string]int64),
		}
	})
	return observeStoreInst
}

func curSlot(nowUnix int64) (int, int64) {
	curMin := nowUnix / 60
	return int(curMin % observeMinuteSlots), curMin
}

func touchBucket(ring *[observeMinuteSlots]minuteBucket, slot int, curMin int64) *minuteBucket {
	b := &ring[slot]
	if b.WindowMin != curMin {
		*b = minuteBucket{WindowMin: curMin}
	}
	return b
}

func (s *observeStore) getOrCreateAccountRing(accountID string) *[observeMinuteSlots]minuteBucket {
	if accountID == "" {
		return nil
	}
	ring, ok := s.accountRings[accountID]
	if ok {
		s.accountTouched[accountID] = observeNow().Unix()
		return ring
	}
	if len(s.accountRings) >= s.maxAccountRing {

		var victim string
		var oldest int64 = 1<<63 - 1
		for id, t := range s.accountTouched {
			if t < oldest {
				oldest = t
				victim = id
			}
		}
		if victim != "" {
			delete(s.accountRings, victim)
			delete(s.accountTouched, victim)
		}
	}
	ring = &[observeMinuteSlots]minuteBucket{}
	s.accountRings[accountID] = ring
	s.accountTouched[accountID] = observeNow().Unix()
	return ring
}

// Seq is the store's change counter. It moves on every Record* call and
// Reset, and when backgroundObserveTick sees the windows move without new data.
func (s *observeStore) Seq() uint64 {
	if s == nil {
		return 0
	}
	return s.seq.Load()
}

// hasTrafficSince reports whether the global ring holds any request or retry
// from sinceMin on.
func (s *observeStore) hasTrafficSince(sinceMin int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.globalRing {
		b := &s.globalRing[i]
		if b.WindowMin >= sinceMin && (b.Reqs > 0 || b.Retries > 0) {
			return true
		}
	}
	return false
}

// countRequestLocked adds one final client request to the global ring, the
// account's ring and the model's stats. A request rejected before any account
// was tried (empty accountID) counts in the global row only.
func (s *observeStore) countRequestLocked(now int64, accountID, model string, success bool, inTokens, outTokens int, credits float64, cache cacheTokenCounts) {
	slot, curMin := curSlot(now)
	add := func(b *minuteBucket) {
		b.Reqs++
		if success {
			b.Successes++
		} else {
			b.Failures++
		}
		b.InTokens += int64(inTokens)
		b.OutTokens += int64(outTokens)
		b.CacheReadTokens += int64(cache.Read)
		b.CacheWriteTokens += int64(cache.Write)
		b.Credits += credits
	}
	add(touchBucket(&s.globalRing, slot, curMin))
	if ring := s.getOrCreateAccountRing(accountID); ring != nil {
		add(touchBucket(ring, slot, curMin))
	}
	//! The model of a rejected request is whatever the client sent; counting it
	//! would let any caller grow the model mix without bound.
	if model != "" && accountID != "" {
		ms := s.modelStatLocked(model)
		ms.Reqs++
		ms.InTokens += int64(inTokens)
		ms.OutTokens += int64(outTokens)
		ms.CacheReadTokens += int64(cache.Read)
		ms.CacheWriteTokens += int64(cache.Write)
		ms.Credits += credits
		ms.LastUsed = now
	}
}

func (s *observeStore) modelStatLocked(model string) *modelStat {
	ms, ok := s.modelStats[model]
	if !ok {
		ms = &modelStat{}
		s.modelStats[model] = ms
	}
	return ms
}

// RecordFailure counts one failed upstream attempt as a retry. The client
// request it belongs to is counted once, when RecordTracedRequestWithCache
// logs its final outcome.
func (s *observeStore) RecordFailure(accountID, model string) {
	if s == nil {
		return
	}
	now := observeNow().Unix()
	slot, curMin := curSlot(now)
	s.mu.Lock()
	touchBucket(&s.globalRing, slot, curMin).Retries++
	if ring := s.getOrCreateAccountRing(accountID); ring != nil {
		touchBucket(ring, slot, curMin).Retries++
	}
	if model != "" && accountID != "" {
		s.modelStatLocked(model).Retries++
	}
	s.mu.Unlock()
	s.seq.Add(1)
}

func (s *observeStore) RecordError(accountID, email, model string, status int, message string) {
	if s == nil {
		return
	}
	if len(message) > 240 {
		message = message[:240]
	}
	rec := errorRecord{
		TS:        observeNow().Unix(),
		AccountID: accountID,
		Email:     email,
		Model:     model,
		Status:    status,
		Message:   message,
	}
	s.mu.Lock()
	s.recentErrors[s.recentErrIdx] = rec
	s.recentErrIdx = (s.recentErrIdx + 1) % observeRecentErrs
	s.mu.Unlock()
	s.seq.Add(1)

	if err := persistErrorRecord(rec); err != nil {
		logger.Warnf("[Observe] Persist error failed: %v", err)
	}
}

func (s *observeStore) RecordRequest(accountID, email, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	s.RecordRequestWithAPIKey(accountID, "", "", email, model, inTokens, outTokens, credits, success, status, message)
}

func (s *observeStore) RecordRequestWithAPIKey(accountID, apiKeyID, apiKey, email, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	s.RecordTracedRequest(nil, accountID, apiKeyID, apiKey, email, model, inTokens, outTokens, credits, success, status, message)
}

func (s *observeStore) RecordTracedRequest(trace *requestTrace, accountID, apiKeyID, apiKey, email, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	s.RecordTracedRequestWithCache(trace, accountID, apiKeyID, apiKey, email, model, inTokens, outTokens, credits, success, status, message, cacheTokenCounts{})
}

// RecordTracedRequestWithCache logs one final client request and counts it
// once in the rings and model stats, success or failure. An empty accountID
// (rejected before an account was picked) counts in the global row only and
// leaves the model mix alone.
func (s *observeStore) RecordTracedRequestWithCache(trace *requestTrace, accountID, apiKeyID, apiKey, email, model string, inTokens, outTokens int, credits float64, success bool, status int, message string, cache cacheTokenCounts) {
	if s == nil {
		return
	}
	errorType := classifyRequestError(success, status, message)
	if len(message) > 500 {
		message = message[:500]
	}
	rec := requestRecord{
		TS:           observeNow().Unix(),
		AccountID:    accountID,
		APIKeyID:     apiKeyID,
		APIKey:       apiKey,
		APIKeyMasked: requestAPIKeyMasked(apiKeyID, apiKey),
		Email:        email,
		Model:        model,
		InTokens:     inTokens,
		OutTokens:    outTokens,
		TotalTokens:  inTokens + outTokens,
		CacheRead:    cache.Read,
		CacheWrite:   cache.Write,
		Credits:      credits,
		Success:      success,
		Status:       status,
		Message:      message,
		Endpoint:     trace.endpointName(),
		DurationMs:   trace.durationMs(),
		ErrorType:    errorType,
	}
	s.mu.Lock()
	s.recentRequests[s.recentReqIdx] = rec
	s.recentReqIdx = (s.recentReqIdx + 1) % observeRecentReqs
	s.countRequestLocked(rec.TS, accountID, model, success, inTokens, outTokens, credits, cache)
	s.mu.Unlock()
	accountRates.record(accountID, rec.TS)
	s.seq.Add(1)

	enqueuePersistRequestRecord(rec)
}

func requestAPIKeyMasked(apiKeyID, apiKey string) string {
	if apiKey == "" && apiKeyID != "" {
		if entry := config.GetApiKeyEntry(apiKeyID); entry != nil {
			apiKey = entry.Key
		}
	}
	if apiKey == "" {
		return ""
	}
	return config.MaskApiKey(apiKey)
}

// OverviewSeries holds one value per minute for the last observeSeriesMin
// minutes, oldest first; the last entry is the current, partial minute.
type OverviewSeries struct {
	RPM     []int     `json:"rpm"`
	ErrRate []float64 `json:"errRate"`
	InTPM   []int64   `json:"inTpm"`
	OutTPM  []int64   `json:"outTpm"`
	Credits []float64 `json:"credits"`
}

type OverviewSnapshot struct {
	StartedAt   int64   `json:"startedAt"`
	NowUnix     int64   `json:"nowUnix"`
	RPM1        int     `json:"rpm1"`
	RPM5Avg     float64 `json:"rpm5Avg"`
	ErrRate5    float64 `json:"errRate5"`
	InTPM5      float64 `json:"inTpm5"`
	OutTPM5     float64 `json:"outTpm5"`
	Credits5    float64 `json:"credits5"`
	Credits60   float64 `json:"credits60"`
	Errors60    int     `json:"errors60"`
	Successes60 int     `json:"successes60"`
	Retries60   int     `json:"retries60"`
	ActiveAccts int     `json:"activeAccts"`
	TotalAccts  int     `json:"totalAccts"`
	TotalModels int     `json:"totalModels"`
	// EnabledAccts and AvailableAccts come from config; the API fills them.
	EnabledAccts   int            `json:"enabledAccts"`
	AvailableAccts int            `json:"availableAccts"`
	Series         OverviewSeries `json:"series"`
}

func (s *observeStore) Overview() OverviewSnapshot {
	if s == nil {
		return OverviewSnapshot{}
	}
	now := observeNow().Unix()
	curSlotIdx, curMin := curSlot(now)
	s.mu.RLock()
	defer s.mu.RUnlock()

	var rpm1, rpm5Total, errs5, succ5, errs60, succ60, retries60 int
	var inTok5, outTok5, credits5, credits60 float64
	series := OverviewSeries{
		RPM:     make([]int, observeSeriesMin),
		ErrRate: make([]float64, observeSeriesMin),
		InTPM:   make([]int64, observeSeriesMin),
		OutTPM:  make([]int64, observeSeriesMin),
		Credits: make([]float64, observeSeriesMin),
	}

	for i := 0; i < 60; i++ {
		idx := (curSlotIdx - i + observeMinuteSlots) % observeMinuteSlots
		b := s.globalRing[idx]
		if b.WindowMin != curMin-int64(i) {
			continue
		}
		if i < 1 {
			rpm1 += b.Reqs
		}
		if i < 5 {
			rpm5Total += b.Reqs
			errs5 += b.Failures
			succ5 += b.Successes
			inTok5 += float64(b.InTokens)
			outTok5 += float64(b.OutTokens)
			credits5 += b.Credits
		}
		if i < observeSeriesMin {
			at := observeSeriesMin - 1 - i
			series.RPM[at] = b.Reqs
			if b.Reqs > 0 {
				series.ErrRate[at] = float64(b.Failures) / float64(b.Reqs)
			}
			series.InTPM[at] = b.InTokens
			series.OutTPM[at] = b.OutTokens
			series.Credits[at] = b.Credits
		}
		errs60 += b.Failures
		succ60 += b.Successes
		retries60 += b.Retries
		credits60 += b.Credits
	}

	activeAccts := 0
	for _, ring := range s.accountRings {
		for i := 0; i < 5; i++ {
			idx := (curSlotIdx - i + observeMinuteSlots) % observeMinuteSlots
			b := ring[idx]
			if b.WindowMin == curMin-int64(i) && b.Reqs > 0 {
				activeAccts++
				break
			}
		}
	}

	errRate := 0.0
	if total := errs5 + succ5; total > 0 {
		errRate = float64(errs5) / float64(total)
	}

	return OverviewSnapshot{
		StartedAt:   s.startedAt,
		NowUnix:     now,
		RPM1:        rpm1,
		RPM5Avg:     float64(rpm5Total) / 5.0,
		ErrRate5:    errRate,
		InTPM5:      inTok5 / 5.0,
		OutTPM5:     outTok5 / 5.0,
		Credits5:    credits5,
		Credits60:   credits60,
		Errors60:    errs60,
		Successes60: succ60,
		Retries60:   retries60,
		ActiveAccts: activeAccts,
		TotalAccts:  len(s.accountRings),
		TotalModels: len(s.modelStats),
		Series:      series,
	}
}

// accountAvailability counts enabled accounts and the ones among them that can
// take traffic: not banned, not suspended, not cooling down and not over their
// usage limit (unless overage is on for the account or over-usage is allowed).
// It is the same rule as pool.AvailableCount, so /status and the overview agree.
// coolingDown may be nil.
func accountAvailability(accounts []config.Account, allowOverUsage bool, coolingDown func(id string) bool) (enabled, available int) {
	for _, a := range accounts {
		if !a.Enabled {
			continue
		}
		enabled++
		if a.Silent || (a.BanStatus != "" && a.BanStatus != "ACTIVE") {
			continue
		}
		if coolingDown != nil && coolingDown(a.ID) {
			continue
		}
		overLimit := a.UsageLimit > 0 && a.UsageCurrent >= a.UsageLimit
		if overLimit && !allowOverUsage && !strings.EqualFold(a.OverageStatus, "ENABLED") {
			continue
		}
		available++
	}
	return enabled, available
}

// accountAvailabilityNow is accountAvailability over the live config and the
// pool's cooldowns.
func (h *Handler) accountAvailabilityNow() (enabled, available int) {
	var coolingDown func(string) bool
	if h.pool != nil {
		now := time.Now()
		coolingDown = func(id string) bool { return h.pool.CooldownUntil(id).After(now) }
	}
	return accountAvailability(config.GetAccounts(), config.GetAllowOverUsage(), coolingDown)
}

type HeatmapCell struct {
	Offset   int     `json:"offset"`
	Reqs     int     `json:"reqs"`
	Failures int     `json:"failures"`
	Retries  int     `json:"retries,omitempty"`
	Credits  float64 `json:"credits,omitempty"`
}

func (c HeatmapCell) empty() bool {
	return c.Reqs == 0 && c.Failures == 0 && c.Retries == 0 && c.Credits == 0
}

type AccountHeatmap struct {
	AccountID string        `json:"accountId"`
	Cells     []HeatmapCell `json:"cells"`
}

type HeatmapResponse struct {
	WindowMin int              `json:"windowMin"`
	BucketMin int              `json:"bucketMin"`
	NowUnix   int64            `json:"nowUnix"`
	Global    AccountHeatmap   `json:"global"`
	Accounts  []AccountHeatmap `json:"accounts"`
	// RestCount is set with Top: busy accounts left out of Accounts.
	RestCount *int `json:"restCount,omitempty"`
}

// HeatmapOptions shapes a heatmap. The zero value (bar WindowMin) is the
// original dense, per-minute, every-account response.
type HeatmapOptions struct {
	WindowMin int
	// BucketMin sums this many minutes per cell; offset N then means N buckets ago.
	BucketMin int
	// GlobalOnly leaves Accounts nil.
	GlobalOnly bool
	// Top keeps the Top accounts with the most requests and retries over the
	// last observeTopRankMin minutes, busiest first, and drops idle ones.
	Top int
	// Sparse leaves out cells with no traffic.
	Sparse bool
}

func (s *observeStore) Heatmap(windowMin int) HeatmapResponse {
	return s.HeatmapWith(HeatmapOptions{WindowMin: windowMin})
}

func (s *observeStore) HeatmapWith(opts HeatmapOptions) HeatmapResponse {
	if s == nil {
		return HeatmapResponse{}
	}
	windowMin := opts.WindowMin
	if windowMin <= 0 {
		windowMin = 60
	}
	if windowMin > observeMinuteSlots {
		windowMin = observeMinuteSlots
	}
	bucketMin := opts.BucketMin
	if bucketMin <= 0 {
		bucketMin = 1
	}
	if bucketMin > windowMin {
		bucketMin = windowMin
	}
	buckets := (windowMin + bucketMin - 1) / bucketMin
	now := observeNow().Unix()
	curSlotIdx, curMin := curSlot(now)

	collect := func(ring *[observeMinuteSlots]minuteBucket) []HeatmapCell {
		cells := make([]HeatmapCell, 0, buckets)
		for n := 0; n < buckets; n++ {
			cell := HeatmapCell{Offset: n}
			for i := n * bucketMin; i < (n+1)*bucketMin && i < windowMin; i++ {
				b := ring[(curSlotIdx-i+observeMinuteSlots)%observeMinuteSlots]
				if b.WindowMin != curMin-int64(i) {
					continue
				}
				cell.Reqs += b.Reqs
				cell.Failures += b.Failures
				cell.Retries += b.Retries
				cell.Credits += b.Credits
			}
			if opts.Sparse && cell.empty() {
				continue
			}
			cells = append(cells, cell)
		}
		return cells
	}
	rank := func(ring *[observeMinuteSlots]minuteBucket) int {
		total := 0
		for i := 0; i < observeTopRankMin; i++ {
			b := ring[(curSlotIdx-i+observeMinuteSlots)%observeMinuteSlots]
			if b.WindowMin == curMin-int64(i) {
				total += b.Reqs + b.Retries
			}
		}
		return total
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	resp := HeatmapResponse{
		WindowMin: windowMin,
		BucketMin: bucketMin,
		NowUnix:   now,
		Global:    AccountHeatmap{AccountID: "_global_", Cells: collect(&s.globalRing)},
	}
	if opts.GlobalOnly {
		return resp
	}

	ids := make([]string, 0, len(s.accountRings))
	for id := range s.accountRings {
		ids = append(ids, id)
	}
	if opts.Top > 0 {
		scores := make(map[string]int, len(ids))
		busy := ids[:0]
		for _, id := range ids {
			if score := rank(s.accountRings[id]); score > 0 {
				scores[id] = score
				busy = append(busy, id)
			}
		}
		sort.Slice(busy, func(i, j int) bool {
			if scores[busy[i]] != scores[busy[j]] {
				return scores[busy[i]] > scores[busy[j]]
			}
			return busy[i] < busy[j]
		})
		rest := 0
		if len(busy) > opts.Top {
			rest = len(busy) - opts.Top
			busy = busy[:opts.Top]
		}
		ids = busy
		resp.RestCount = &rest
	} else {
		sort.Strings(ids)
	}
	resp.Accounts = make([]AccountHeatmap, 0, len(ids))
	for _, id := range ids {
		resp.Accounts = append(resp.Accounts, AccountHeatmap{AccountID: id, Cells: collect(s.accountRings[id])})
	}
	return resp
}

type ModelMixEntry struct {
	Model            string  `json:"model"`
	Reqs             int64   `json:"reqs"`
	Retries          int64   `json:"retries"`
	InTokens         int64   `json:"inTokens"`
	OutTokens        int64   `json:"outTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	Credits          float64 `json:"credits"`
	LastUsed         int64   `json:"lastUsed"`
}

func (s *observeStore) ModelMix() []ModelMixEntry {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ModelMixEntry, 0, len(s.modelStats))
	for m, st := range s.modelStats {
		out = append(out, ModelMixEntry{
			Model:            m,
			Reqs:             st.Reqs,
			Retries:          st.Retries,
			InTokens:         st.InTokens,
			OutTokens:        st.OutTokens,
			CacheReadTokens:  st.CacheReadTokens,
			CacheWriteTokens: st.CacheWriteTokens,
			Credits:          st.Credits,
			LastUsed:         st.LastUsed,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Credits > out[j].Credits
	})
	return out
}

func (s *observeStore) RecentErrors(limit int) []errorRecord {
	if s == nil {
		return nil
	}
	if limit <= 0 || limit > observeRecentErrs {
		limit = observeRecentErrs
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]errorRecord, 0, limit)

	for i := 0; i < observeRecentErrs && len(out) < limit; i++ {
		idx := (s.recentErrIdx - 1 - i + observeRecentErrs) % observeRecentErrs
		rec := s.recentErrors[idx]
		if rec.TS == 0 {
			continue
		}
		out = append(out, rec)
	}
	return out
}

func (s *observeStore) RecentRequests(limit int) []requestRecord {
	if s == nil {
		return nil
	}
	if limit <= 0 || limit > observeRecentReqs {
		limit = observeRecentReqs
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]requestRecord, 0, limit)
	for i := 0; i < observeRecentReqs && len(out) < limit; i++ {
		idx := (s.recentReqIdx - 1 - i + observeRecentReqs) % observeRecentReqs
		rec := s.recentRequests[idx]
		if rec.TS == 0 {
			continue
		}
		out = append(out, rec)
	}
	return out
}

func normalizeRequestQuery(q requestQuery) requestQuery {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize <= 0 {
		q.PageSize = 25
	}
	if q.PageSize > 200 {
		q.PageSize = 200
	}
	q.Search = strings.TrimSpace(q.Search)
	q.Status = strings.TrimSpace(strings.ToLower(q.Status))
	if q.Status != "success" && q.Status != "failed" {
		q.Status = ""
	}
	q.Sort = strings.TrimSpace(strings.ToLower(q.Sort))
	switch q.Sort {
	case "time", "status", "account", "api_key", "model", "tokens", "credits", "duration":
	default:
		q.Sort = "time"
	}
	q.Order = strings.TrimSpace(strings.ToLower(q.Order))
	if q.Order != "asc" {
		q.Order = "desc"
	}
	return q
}

func (s *observeStore) RequestPage(q requestQuery) requestPage {
	q = normalizeRequestQuery(q)
	if page, err := queryPersistedRequests(q); err == nil && page.Persistent {
		return page
	} else if err != nil {
		logger.Warnf("[Observe] Query persisted requests failed: %v", err)
	}
	return s.memoryRequestPage(q)
}

func (s *observeStore) memoryRequestPage(q requestQuery) requestPage {
	all := s.RecentRequests(observeRecentReqs)
	filtered := make([]requestRecord, 0, len(all))
	search := strings.ToLower(q.Search)
	for _, rec := range all {
		if q.Status == "success" && !rec.Success {
			continue
		}
		if q.Status == "failed" && rec.Success {
			continue
		}
		if search != "" {
			haystack := strings.ToLower(rec.Email + " " + rec.AccountID + " " + rec.APIKeyID + " " + rec.APIKey + " " + rec.APIKeyMasked + " " + rec.Model + " " + rec.Message + " " + rec.Endpoint + " " + rec.ErrorType)
			if !strings.Contains(haystack, search) {
				continue
			}
		}
		filtered = append(filtered, rec)
	}
	sort.Slice(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		compare := 0
		switch q.Sort {
		case "status":
			compare = boolInt(a.Success) - boolInt(b.Success)
		case "account":
			compare = strings.Compare(strings.ToLower(a.Email+a.AccountID), strings.ToLower(b.Email+b.AccountID))
		case "api_key":
			compare = strings.Compare(strings.ToLower(a.APIKey+a.APIKeyID), strings.ToLower(b.APIKey+b.APIKeyID))
		case "model":
			compare = strings.Compare(strings.ToLower(a.Model), strings.ToLower(b.Model))
		case "tokens":
			compare = a.TotalTokens - b.TotalTokens
		case "credits":
			if a.Credits < b.Credits {
				compare = -1
			} else if a.Credits > b.Credits {
				compare = 1
			}
		case "duration":
			if a.DurationMs < b.DurationMs {
				compare = -1
			} else if a.DurationMs > b.DurationMs {
				compare = 1
			}
		default:
			if a.TS < b.TS {
				compare = -1
			} else if a.TS > b.TS {
				compare = 1
			}
		}
		if compare == 0 {
			if a.TS < b.TS {
				compare = -1
			} else if a.TS > b.TS {
				compare = 1
			}
		}
		if q.Order == "desc" {
			return compare > 0
		}
		return compare < 0
	})
	total := len(filtered)
	start := (q.Page - 1) * q.PageSize
	if start > total {
		start = total
	}
	end := start + q.PageSize
	if end > total {
		end = total
	}
	return requestPage{
		Requests:   filtered[start:end],
		Total:      total,
		Page:       q.Page,
		PageSize:   q.PageSize,
		Sort:       q.Sort,
		Order:      q.Order,
		Persistent: false,
	}
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (s *observeStore) Reset() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.resetLocked()
	s.startedAt = observeNow().Unix()
	s.mu.Unlock()
	accountRates.reset()
	s.seq.Add(1)
}

// resetLocked empties every ring, model stat and recent list.
func (s *observeStore) resetLocked() {
	s.generation++
	for i := range s.globalRing {
		s.globalRing[i] = minuteBucket{}
	}
	s.accountRings = make(map[string]*[observeMinuteSlots]minuteBucket)
	s.accountTouched = make(map[string]int64)
	s.modelStats = make(map[string]*modelStat)
	s.recentErrors = make([]errorRecord, observeRecentErrs)
	s.recentErrIdx = 0
	s.recentRequests = make([]requestRecord, observeRecentReqs)
	s.recentReqIdx = 0
}

// pruneAccountRings drops the rings of accounts that are no longer configured,
// so deleted accounts leave the heatmap and the totals.
func (s *observeStore) pruneAccountRings(accounts []config.Account) int {
	if s == nil {
		return 0
	}
	keep := make(map[string]bool, len(accounts))
	for _, a := range accounts {
		keep[a.ID] = true
	}
	s.mu.Lock()
	removed := 0
	for id := range s.accountRings {
		if !keep[id] {
			delete(s.accountRings, id)
			delete(s.accountTouched, id)
			removed++
		}
	}
	s.mu.Unlock()
	if removed > 0 {
		s.seq.Add(1)
	}
	return removed
}

const (
	observeTickInterval = time.Second
	// observePruneEvery is how many ticks pass between account-ring prunes.
	observePruneEvery = 30
)

// observeTickState remembers what the last observe_tick reflected.
type observeTickState struct {
	seq                uint64
	minute             int64
	enabled, available int
}

// advance moves seq when the overview changed without a store write, then
// reports the seq to publish, if any. Two things change it that way:
//   - a minute ends while the rings hold traffic: every window is anchored to
//     the current minute, so rates decay and heatmap cells shift;
//   - the enabled or available account count changes (a cooldown ends, an
//     account is enabled), which the overview reports next to the rings.
func (t *observeTickState) advance(store *observeStore, minute int64, enabled, available int) (uint64, bool) {
	if minute != t.minute {
		t.minute = minute
		//! The heatmap serves up to observeMinuteSlots minutes, so traffic anywhere in
		//! that span still moves on screen; a store idle for a whole day stays quiet.
		if store.hasTrafficSince(minute - observeMinuteSlots) {
			store.seq.Add(1)
		}
	}
	if enabled != t.enabled || available != t.available {
		t.enabled, t.available = enabled, available
		store.seq.Add(1)
	}
	seq := store.Seq()
	if seq == t.seq {
		return seq, false
	}
	t.seq = seq
	return seq, true
}

// backgroundObserveTick tells admin pages that observe data changed. It sends
// at most one observe_tick per second: after a store write, when a minute ends
// while recent traffic is on screen, or when account availability changes.
func (h *Handler) backgroundObserveTick() {
	ticker := time.NewTicker(observeTickInterval)
	defer ticker.Stop()
	store := getObserveStore()
	_, minute := curSlot(observeNow().Unix())
	state := observeTickState{seq: store.Seq(), minute: minute}
	state.enabled, state.available = h.accountAvailabilityNow()
	for tick := 0; ; tick++ {
		select {
		case <-h.stopStatsSaver:
			return
		case <-ticker.C:
			if tick%observePruneEvery == 0 {
				store.pruneAccountRings(config.GetAccounts())
			}
			_, minute := curSlot(observeNow().Unix())
			enabled, available := h.accountAvailabilityNow()
			if seq, ok := state.advance(store, minute, enabled, available); ok {
				publishObserveTick(seq)
			}
		}
	}
}
