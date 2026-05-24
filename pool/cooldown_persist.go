// Package pool: cooldown state persistence.
package pool

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"kiro-go/config"
	"kiro-go/logger"
)

func cooldownDataFile() string {
	return filepath.Join(config.GetDataDir(), "pool", "cooldowns.json")
}

// cooldownPersistData 持久化数据结构
type cooldownPersistData struct {
	SavedAt   int64            `json:"savedAt"`
	Cooldowns map[string]int64 `json:"cooldowns"` // accountID → Unix timestamp
}

// SaveCooldowns 保存冷却状态到磁盘
func (p *AccountPool) SaveCooldowns() error {
	if p == nil {
		return nil
	}
	p.mu.RLock()
	cooldowns := make(map[string]int64, len(p.cooldowns))
	now := time.Now()
	for id, t := range p.cooldowns {
		// 只保存未过期的冷却状态
		if t.After(now) {
			cooldowns[id] = t.Unix()
		}
	}
	p.mu.RUnlock()

	data := cooldownPersistData{
		SavedAt:   now.Unix(),
		Cooldowns: cooldowns,
	}

	path := cooldownDataFile()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, jsonData, 0600)
}

// loadCooldowns 从磁盘加载冷却状态
func (p *AccountPool) loadCooldowns() error {
	if p == nil {
		return nil
	}
	path := cooldownDataFile()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var persist cooldownPersistData
	if err := json.Unmarshal(data, &persist); err != nil {
		return err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	loaded := 0
	for id, ts := range persist.Cooldowns {
		t := time.Unix(ts, 0)
		// 只恢复未过期的冷却状态
		if t.After(now) {
			p.cooldowns[id] = t
			loaded++
		}
	}

	if loaded > 0 {
		logger.Infof("[Pool] Loaded %d active cooldowns from %s", loaded, path)
	}
	return nil
}
