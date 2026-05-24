// Package proxy: in-memory observability store.
// 维护 24h 分钟环形桶 + 账号级环形桶 + 模型聚合 + 最近错误流。
// 全部内存实现，进程重启即清零；不污染 config.json。
package proxy

import (
	"sort"
	"strings"
	"sync"
	"time"

	"kiro-go/logger"
)

const (
	observeMinuteSlots = 1440 // 24h × 60min
	observeRecentErrs  = 100  // 最近错误流容量
	observeRecentReqs  = 200  // 最近请求流容量
)

// minuteBucket 一分钟内的聚合数据
type minuteBucket struct {
	WindowMin int64 // unix minute (用于校验是否过期/被回收)
	Reqs      int
	Successes int
	Failures  int
	InTokens  int64
	OutTokens int64
	Credits   float64
}

// modelStat 模型级聚合（生命周期内累计）
type modelStat struct {
	Reqs      int64
	InTokens  int64
	OutTokens int64
	Credits   float64
	LastUsed  int64
}

// errorRecord 最近错误流条目
type errorRecord struct {
	TS        int64  `json:"ts"`
	AccountID string `json:"accountId"`
	Email     string `json:"email,omitempty"`
	Model     string `json:"model,omitempty"`
	Status    int    `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
}

// requestRecord 请求记录条目
type requestRecord struct {
	ID          int64   `json:"id,omitempty"`
	TS          int64   `json:"ts"`
	AccountID   string  `json:"accountId"`
	Email       string  `json:"email,omitempty"`
	Model       string  `json:"model"`
	InTokens    int     `json:"inTokens"`
	OutTokens   int     `json:"outTokens"`
	TotalTokens int     `json:"totalTokens"`
	Credits     float64 `json:"credits"`
	Success     bool    `json:"success"`
	Status      int     `json:"status,omitempty"`
	Message     string  `json:"message,omitempty"`
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

// observeStore 全局只读单例，写入加锁。
type observeStore struct {
	mu             sync.RWMutex
	startedAt      int64
	globalRing     [observeMinuteSlots]minuteBucket
	accountRings   map[string]*[observeMinuteSlots]minuteBucket
	modelStats     map[string]*modelStat
	recentErrors   []errorRecord // 循环写入
	recentErrIdx   int
	recentRequests []requestRecord // 循环写入
	recentReqIdx   int
	maxAccountRing int // 上限保护，超过则不再新建账号桶（按 LRU 淘汰）
	accountTouched map[string]int64
}

var (
	observeStoreOnce sync.Once
	observeStoreInst *observeStore
)

func getObserveStore() *observeStore {
	observeStoreOnce.Do(func() {
		observeStoreInst = &observeStore{
			startedAt:      time.Now().Unix(),
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

// curSlot 当前分钟在环中的下标
func curSlot(nowUnix int64) (int, int64) {
	curMin := nowUnix / 60
	return int(curMin % observeMinuteSlots), curMin
}

// touchBucket 取/重置该分钟桶（窗口跳变即清零）
func touchBucket(ring *[observeMinuteSlots]minuteBucket, slot int, curMin int64) *minuteBucket {
	b := &ring[slot]
	if b.WindowMin != curMin {
		*b = minuteBucket{WindowMin: curMin}
	}
	return b
}

// getOrCreateAccountRing 受 maxAccountRing 保护，必要时淘汰最久未访问的账号桶
func (s *observeStore) getOrCreateAccountRing(accountID string) *[observeMinuteSlots]minuteBucket {
	if accountID == "" {
		return nil
	}
	ring, ok := s.accountRings[accountID]
	if ok {
		s.accountTouched[accountID] = time.Now().Unix()
		return ring
	}
	if len(s.accountRings) >= s.maxAccountRing {
		// LRU 淘汰
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
	s.accountTouched[accountID] = time.Now().Unix()
	return ring
}

// RecordSuccess 一次成功请求落账
func (s *observeStore) RecordSuccess(accountID, model string, inTokens, outTokens int, credits float64) {
	if s == nil {
		return
	}
	now := time.Now().Unix()
	slot, curMin := curSlot(now)
	s.mu.Lock()
	defer s.mu.Unlock()

	g := touchBucket(&s.globalRing, slot, curMin)
	g.Reqs++
	g.Successes++
	g.InTokens += int64(inTokens)
	g.OutTokens += int64(outTokens)
	g.Credits += credits

	if ring := s.getOrCreateAccountRing(accountID); ring != nil {
		b := touchBucket(ring, slot, curMin)
		b.Reqs++
		b.Successes++
		b.InTokens += int64(inTokens)
		b.OutTokens += int64(outTokens)
		b.Credits += credits
	}

	if model != "" {
		ms, ok := s.modelStats[model]
		if !ok {
			ms = &modelStat{}
			s.modelStats[model] = ms
		}
		ms.Reqs++
		ms.InTokens += int64(inTokens)
		ms.OutTokens += int64(outTokens)
		ms.Credits += credits
		ms.LastUsed = now
	}
}

// RecordFailure 一次失败请求落账（不记 tokens）
func (s *observeStore) RecordFailure(accountID, model string) {
	if s == nil {
		return
	}
	now := time.Now().Unix()
	slot, curMin := curSlot(now)
	s.mu.Lock()
	defer s.mu.Unlock()

	g := touchBucket(&s.globalRing, slot, curMin)
	g.Reqs++
	g.Failures++

	if ring := s.getOrCreateAccountRing(accountID); ring != nil {
		b := touchBucket(ring, slot, curMin)
		b.Reqs++
		b.Failures++
	}

	if model != "" {
		ms, ok := s.modelStats[model]
		if !ok {
			ms = &modelStat{}
			s.modelStats[model] = ms
		}
		ms.Reqs++
		ms.LastUsed = now
	}
}

// RecordError 记录一条错误流（错误窗外，仅供 admin 查看）
func (s *observeStore) RecordError(accountID, email, model string, status int, message string) {
	if s == nil {
		return
	}
	if len(message) > 240 {
		message = message[:240]
	}
	rec := errorRecord{
		TS:        time.Now().Unix(),
		AccountID: accountID,
		Email:     email,
		Model:     model,
		Status:    status,
		Message:   message,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recentErrors[s.recentErrIdx] = rec
	s.recentErrIdx = (s.recentErrIdx + 1) % observeRecentErrs
}

// RecordRequest 记录一次请求（成功或失败）
func (s *observeStore) RecordRequest(accountID, email, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	if s == nil {
		return
	}
	if len(message) > 500 {
		message = message[:500]
	}
	rec := requestRecord{
		TS:          time.Now().Unix(),
		AccountID:   accountID,
		Email:       email,
		Model:       model,
		InTokens:    inTokens,
		OutTokens:   outTokens,
		TotalTokens: inTokens + outTokens,
		Credits:     credits,
		Success:     success,
		Status:      status,
		Message:     message,
	}
	s.mu.Lock()
	s.recentRequests[s.recentReqIdx] = rec
	s.recentReqIdx = (s.recentReqIdx + 1) % observeRecentReqs
	s.mu.Unlock()

	if err := persistRequestRecord(rec); err != nil {
		logger.Warnf("[Observe] Persist request failed: %v", err)
	}
}

// ==================== 读出快照 ====================

// OverviewSnapshot 全局总览（最近 1 分钟与最近 5 分钟均值）
type OverviewSnapshot struct {
	StartedAt   int64   `json:"startedAt"`
	NowUnix     int64   `json:"nowUnix"`
	RPM1        int     `json:"rpm1"`        // 最近 1min 请求数
	RPM5Avg     float64 `json:"rpm5Avg"`     // 最近 5min 平均
	ErrRate5    float64 `json:"errRate5"`    // 最近 5min 错误率 (0-1)
	InTPM5      float64 `json:"inTpm5"`      // 5min 入 tokens / min
	OutTPM5     float64 `json:"outTpm5"`     // 5min 出 tokens / min
	Credits5    float64 `json:"credits5"`    // 5min credits 之和
	Credits60   float64 `json:"credits60"`   // 60min credits 之和
	Errors60    int     `json:"errors60"`    // 最近 60min 失败数
	Successes60 int     `json:"successes60"` // 最近 60min 成功数
	ActiveAccts int     `json:"activeAccts"` // 最近 5min 有流量的账号数
	TotalAccts  int     `json:"totalAccts"`  // 累计被记录过的账号数
	TotalModels int     `json:"totalModels"` // 累计模型数
}

func (s *observeStore) Overview() OverviewSnapshot {
	if s == nil {
		return OverviewSnapshot{}
	}
	now := time.Now().Unix()
	curSlotIdx, curMin := curSlot(now)
	s.mu.RLock()
	defer s.mu.RUnlock()

	var rpm1, rpm5Total, errs5, succ5, errs60, succ60 int
	var inTok5, outTok5, credits5, credits60 float64

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
		errs60 += b.Failures
		succ60 += b.Successes
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
		ActiveAccts: activeAccts,
		TotalAccts:  len(s.accountRings),
		TotalModels: len(s.modelStats),
	}
}

// HeatmapCell 单格数据
type HeatmapCell struct {
	Offset   int     `json:"offset"` // 距当前分钟的负偏移 (0..windowMin-1)
	Reqs     int     `json:"reqs"`
	Failures int     `json:"failures"`
	Credits  float64 `json:"credits,omitempty"`
}

// AccountHeatmap 单账号热图
type AccountHeatmap struct {
	AccountID string        `json:"accountId"`
	Cells     []HeatmapCell `json:"cells"`
}

// HeatmapResponse 全部账号 + global 的热图
type HeatmapResponse struct {
	WindowMin int              `json:"windowMin"` // 取几分钟（默认 60，最大 1440）
	NowUnix   int64            `json:"nowUnix"`
	Global    AccountHeatmap   `json:"global"`
	Accounts  []AccountHeatmap `json:"accounts"`
}

func (s *observeStore) Heatmap(windowMin int) HeatmapResponse {
	if s == nil {
		return HeatmapResponse{}
	}
	if windowMin <= 0 {
		windowMin = 60
	}
	if windowMin > observeMinuteSlots {
		windowMin = observeMinuteSlots
	}
	now := time.Now().Unix()
	curSlotIdx, curMin := curSlot(now)

	collect := func(ring *[observeMinuteSlots]minuteBucket) []HeatmapCell {
		cells := make([]HeatmapCell, windowMin)
		for i := 0; i < windowMin; i++ {
			idx := (curSlotIdx - i + observeMinuteSlots) % observeMinuteSlots
			b := ring[idx]
			cell := HeatmapCell{Offset: i}
			if b.WindowMin == curMin-int64(i) {
				cell.Reqs = b.Reqs
				cell.Failures = b.Failures
				cell.Credits = b.Credits
			}
			cells[i] = cell
		}
		return cells
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	resp := HeatmapResponse{
		WindowMin: windowMin,
		NowUnix:   now,
		Global:    AccountHeatmap{AccountID: "_global_", Cells: collect(&s.globalRing)},
	}
	for id, ring := range s.accountRings {
		resp.Accounts = append(resp.Accounts, AccountHeatmap{AccountID: id, Cells: collect(ring)})
	}
	// 排序，按账号 ID 稳定
	sort.Slice(resp.Accounts, func(i, j int) bool {
		return resp.Accounts[i].AccountID < resp.Accounts[j].AccountID
	})
	return resp
}

// ModelMixEntry 模型聚合
type ModelMixEntry struct {
	Model     string  `json:"model"`
	Reqs      int64   `json:"reqs"`
	InTokens  int64   `json:"inTokens"`
	OutTokens int64   `json:"outTokens"`
	Credits   float64 `json:"credits"`
	LastUsed  int64   `json:"lastUsed"`
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
			Model:     m,
			Reqs:      st.Reqs,
			InTokens:  st.InTokens,
			OutTokens: st.OutTokens,
			Credits:   st.Credits,
			LastUsed:  st.LastUsed,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Credits > out[j].Credits
	})
	return out
}

// RecentErrors 倒序返回最近错误（最新在前）
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
	// 从 recentErrIdx-1 开始往前遍历
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

// RecentRequests 返回最近的请求记录（最新的在前）
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
	case "time", "status", "account", "model", "tokens", "credits":
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
		if page.Total > 0 || len(s.RecentRequests(1)) == 0 {
			return page
		}
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
			haystack := strings.ToLower(rec.Email + " " + rec.AccountID + " " + rec.Model + " " + rec.Message)
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

// Reset 清空（用于 admin /stats/reset 触发的同步重置）
func (s *observeStore) Reset() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.startedAt = time.Now().Unix()
}

// backgroundObserveTick 5s 周期通过 broadcaster 推送 observe_tick 事件，
// 前端收到后拉最新数据。停机信号复用 stopStatsSaver（同生命周期）。
func (h *Handler) backgroundObserveTick() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopStatsSaver:
			return
		case <-ticker.C:
			publishObserveTick()
		}
	}
}
