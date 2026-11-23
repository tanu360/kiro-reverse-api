package pool

import (
	"math/rand"
	"time"
)

type RetryConfig struct {
	MaxPerAccount int
	MaxPerRequest int
	BaseDelay     time.Duration
	MaxDelay      time.Duration
}

func (rc RetryConfig) CalculateBackoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}

	//! Doubling past MaxDelay overflows int64 within a few dozen attempts and wraps to a
	//! negative or zero delay, so the cap is checked before the shift.
	delay := rc.MaxDelay
	if attempt < 63 && rc.BaseDelay <= rc.MaxDelay>>attempt {
		delay = rc.BaseDelay << attempt
	}
	if delay <= 0 {
		return 0
	}

	jitterRange := int64(delay) / 2
	if jitterRange <= 0 {
		return delay
	}
	jitter := time.Duration(rand.Int63n(jitterRange))
	if rand.Intn(2) == 0 {
		delay += jitter
	} else {
		delay -= jitter
	}

	if delay < 0 {
		delay = 0
	}

	return delay
}
