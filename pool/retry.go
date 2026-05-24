// Package pool: retry logic with exponential backoff and jitter.
package pool

import (
	"math/rand"
	"time"
)

// RetryConfig holds retry parameters for request-level fault tolerance.
type RetryConfig struct {
	MaxPerAccount int           // Max retries per single account (default: 3)
	MaxPerRequest int           // Max retries across all accounts (default: 9)
	BaseDelay     time.Duration // Base delay (default: 100ms)
	MaxDelay      time.Duration // Max delay (default: 5s)
}

// DefaultRetryConfig returns the default retry configuration.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxPerAccount: 3,
		MaxPerRequest: 9,
		BaseDelay:     100 * time.Millisecond,
		MaxDelay:      5 * time.Second,
	}
}

// CalculateBackoff returns the delay for the given attempt number using exponential backoff with jitter.
// attempt is 0-indexed (0 = first retry).
func (rc RetryConfig) CalculateBackoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}

	// Exponential backoff: baseDelay * 2^attempt
	delay := rc.BaseDelay * time.Duration(1<<uint(attempt))

	// Cap at maxDelay
	delay = min(delay, rc.MaxDelay)
	if delay <= 0 {
		return 0
	}

	// Add jitter: ±25% randomization
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

	// Ensure non-negative
	if delay < 0 {
		delay = 0
	}

	return delay
}
