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

func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxPerAccount: 3,
		MaxPerRequest: 9,
		BaseDelay:     100 * time.Millisecond,
		MaxDelay:      5 * time.Second,
	}
}

func (rc RetryConfig) CalculateBackoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}

	delay := rc.BaseDelay * time.Duration(1<<uint(attempt))

	delay = min(delay, rc.MaxDelay)
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
