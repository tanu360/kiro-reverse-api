package proxy

import (
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// backupTick is how often the scheduler checks whether a backup is due. Ticks
// fall on wall-clock multiples of it, so nextRun can be predicted exactly.
const backupTick = 5 * time.Minute

func (h *Handler) backgroundBackupScheduler() {
	timer := time.NewTimer(untilBackupTick(time.Now()))
	defer timer.Stop()
	for {
		select {
		case <-h.stopStatsSaver:
			return
		case <-timer.C:
			h.maybeRunScheduledBackup()
			//! Re-armed from the wall clock each time: a Ticker follows the monotonic
			//! clock, so a slow run or a clock step would drift it off the ticks nextRun names.
			timer.Reset(untilBackupTick(time.Now()))
		}
	}
}

// untilBackupTick is how long from now until the first scheduler tick after it.
func untilBackupTick(now time.Time) time.Duration {
	//! Truncate drops the monotonic reading, so the wait is measured on the wall clock.
	return now.Truncate(backupTick).Add(backupTick).Sub(now)
}

// nextBackupTick is the first scheduler tick at or after t.
func nextBackupTick(t time.Time) time.Time {
	tick := t.Truncate(backupTick)
	if tick.Before(t) {
		tick = tick.Add(backupTick)
	}
	return tick
}

// backupInterval is the cadence's period in seconds; 0 for an unknown cadence.
func backupInterval(cadence string) int64 {
	switch cadence {
	case "hourly":
		return 3600
	case "daily":
		return 86400
	case "weekly":
		return 604800
	default:
		return 0
	}
}

// nextScheduledBackup is when the scheduler will take the next backup: the
// later of lastRun+interval and now, rounded up to the next tick. Zero while
// the schedule is off or its cadence unknown.
func nextScheduledBackup(sched config.BackupSchedule, now time.Time) int64 {
	interval := backupInterval(sched.Cadence)
	if !sched.Enabled || interval == 0 {
		return 0
	}
	due := now
	if sched.LastRun > 0 {
		if at := time.Unix(sched.LastRun+interval, 0); at.After(due) {
			due = at
		}
	}
	return nextBackupTick(due).Unix()
}

func (h *Handler) maybeRunScheduledBackup() {
	sched := config.GetBackupSchedule()
	if !sched.Enabled {
		return
	}
	now := time.Now().Unix()
	interval := backupInterval(sched.Cadence)
	if interval == 0 {
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
	if _, err := config.PruneScheduled(); err != nil {
		logger.Warnf("[Backup] Prune scheduled backups failed: %v", err)
	}
	publishEvent(eventBackupCreated, entry.ID)
	logger.Infof("[Backup] Scheduled backup created: %s", entry.ID)
}
