// Package proxy: background backup scheduler.
package proxy

import (
	"time"

	"kiro-go/config"
	"kiro-go/logger"
)

// backgroundBackupScheduler 定时快照后台任务。
// 按 BackupSchedule.Cadence（hourly/daily/weekly）周期触发 scheduled 类快照。
// 停机信号复用 stopStatsSaver（同生命周期）。
func (h *Handler) backgroundBackupScheduler() {
	ticker := time.NewTicker(5 * time.Minute) // 每 5 分钟检查一次
	defer ticker.Stop()
	for {
		select {
		case <-h.stopStatsSaver:
			return
		case <-ticker.C:
			h.maybeRunScheduledBackup()
		}
	}
}

func (h *Handler) maybeRunScheduledBackup() {
	sched := config.GetBackupSchedule()
	if !sched.Enabled {
		return
	}
	now := time.Now().Unix()
	var interval int64
	switch sched.Cadence {
	case "hourly":
		interval = 3600
	case "daily":
		interval = 86400
	case "weekly":
		interval = 604800
	default:
		return
	}
	if sched.LastRun > 0 && now-sched.LastRun < interval {
		return
	}
	logger.Infof("[Backup] Running scheduled backup (cadence: %s)", sched.Cadence)
	entry, err := config.CreateBackup("scheduled", "auto-"+sched.Cadence)
	if err != nil {
		logger.Warnf("[Backup] Scheduled backup failed: %v", err)
		return
	}
	if err := config.MarkScheduleRan(now); err != nil {
		logger.Warnf("[Backup] Persist scheduled backup timestamp failed: %v", err)
	}
	if err := config.PruneScheduled(); err != nil {
		logger.Warnf("[Backup] Prune scheduled backups failed: %v", err)
	}
	getBroadcaster().Publish(Event{Type: "backup_created", Payload: entry.ID})
	logger.Infof("[Backup] Scheduled backup created: %s", entry.ID)
}
