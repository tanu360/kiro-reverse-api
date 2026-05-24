package proxy

import (
	"time"

	"kiro-go/logger"
)

func (h *Handler) backgroundCooldownSaver() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-h.stopStatsSaver:
			if err := h.pool.SaveCooldowns(); err != nil {
				logger.Warnf("[Pool] Failed to save cooldowns on shutdown: %v", err)
			}
			return
		case <-ticker.C:
			if err := h.pool.SaveCooldowns(); err != nil {
				logger.Warnf("[Pool] Failed to save cooldowns: %v", err)
			}
		}
	}
}
