// Package proxy: observe data persistence.
package proxy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"kiro-go/logger"
)

const observeDataFile = "data/observe/observe.json"

// observePersistData 持久化数据结构
type observePersistData struct {
	SavedAt        int64           `json:"savedAt"`
	RecentRequests []requestRecord `json:"recentRequests"`
	RecentErrors   []errorRecord   `json:"recentErrors"`
}

// Save 保存观测数据到磁盘
func (s *observeStore) Save() error {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	reqs := make([]requestRecord, 0, observeRecentReqs)
	for i := 0; i < observeRecentReqs; i++ {
		idx := (s.recentReqIdx - 1 - i + observeRecentReqs) % observeRecentReqs
		rec := s.recentRequests[idx]
		if rec.TS == 0 {
			continue
		}
		reqs = append(reqs, rec)
	}
	errs := make([]errorRecord, 0, observeRecentErrs)
	for i := 0; i < observeRecentErrs; i++ {
		idx := (s.recentErrIdx - 1 - i + observeRecentErrs) % observeRecentErrs
		rec := s.recentErrors[idx]
		if rec.TS == 0 {
			continue
		}
		errs = append(errs, rec)
	}
	s.mu.RUnlock()

	data := observePersistData{
		SavedAt:        time.Now().Unix(),
		RecentRequests: reqs,
		RecentErrors:   errs,
	}

	dir := filepath.Dir(observeDataFile)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(observeDataFile, jsonData, 0600)
}

// Load 从磁盘加载观测数据
func (s *observeStore) Load() error {
	if s == nil {
		return nil
	}
	data, err := os.ReadFile(observeDataFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var persist observePersistData
	if err := json.Unmarshal(data, &persist); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// 恢复请求记录（最新的在前，需要反向写入）
	for i := len(persist.RecentRequests) - 1; i >= 0; i-- {
		s.recentRequests[s.recentReqIdx] = persist.RecentRequests[i]
		s.recentReqIdx = (s.recentReqIdx + 1) % observeRecentReqs
	}

	// 恢复错误记录
	for i := len(persist.RecentErrors) - 1; i >= 0; i-- {
		s.recentErrors[s.recentErrIdx] = persist.RecentErrors[i]
		s.recentErrIdx = (s.recentErrIdx + 1) % observeRecentErrs
	}

	logger.Infof("[Observe] Loaded %d requests, %d errors from %s", len(persist.RecentRequests), len(persist.RecentErrors), observeDataFile)
	return nil
}

// backgroundObserveSaver 后台定期保存观测数据
func (h *Handler) backgroundObserveSaver() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopStatsSaver:
			// 停机前最后保存一次
			if err := getObserveStore().Save(); err != nil {
				logger.Warnf("[Observe] Failed to save on shutdown: %v", err)
			}
			return
		case <-ticker.C:
			if err := getObserveStore().Save(); err != nil {
				logger.Warnf("[Observe] Failed to save: %v", err)
			}
		}
	}
}
