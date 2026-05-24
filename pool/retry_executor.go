// Package pool: retry execution orchestrator
package pool

import (
	"fmt"
	"kiro-go/config"
	"time"
)

// RetryResult holds the outcome of a retry attempt.
type RetryResult struct {
	Account       *config.Account
	Attempt       int // 0-indexed attempt number
	TotalAttempts int // Total attempts made across all accounts
	Success       bool
	Error         error
}

// RetryExecutor orchestrates multi-account retry with exponential backoff.
type RetryExecutor struct {
	pool   *AccountPool
	config RetryConfig
}

// NewRetryExecutor creates a retry executor with config from global settings.
func NewRetryExecutor(pool *AccountPool) *RetryExecutor {
	maxPerAccount, maxPerRequest, baseDelayMs, maxDelayMs := config.GetRetryConfig()
	return &RetryExecutor{
		pool: pool,
		config: RetryConfig{
			MaxPerAccount: maxPerAccount,
			MaxPerRequest: maxPerRequest,
			BaseDelay:     time.Duration(baseDelayMs) * time.Millisecond,
			MaxDelay:      time.Duration(maxDelayMs) * time.Millisecond,
		},
	}
}

// ExecuteWithRetry attempts to get an account and execute fn, retrying on failure.
// model: target model (after stripping thinking suffix)
// fn: function to execute with the account, returns (shouldRetry, error)
//
//	shouldRetry=true means the error is transient and retry is worthwhile
func (re *RetryExecutor) ExecuteWithRetry(
	model string,
	fn func(acc *config.Account) (shouldRetry bool, err error),
) (*RetryResult, error) {
	excludeIDs := make(map[string]bool)
	totalAttempts := 0
	var lastErr error

	for totalAttempts < re.config.MaxPerRequest {
		// Get next available account (excluding failed ones)
		acc := re.pool.GetNextForModelExcluding(model, excludeIDs)
		if acc == nil {
			return nil, fmt.Errorf("no available accounts after %d attempts (excluded: %d)", totalAttempts, len(excludeIDs))
		}

		accountAttempts := 0
		for accountAttempts < re.config.MaxPerAccount {
			totalAttempts++
			accountAttempts++

			// Execute the function
			shouldRetry, err := fn(acc)
			if err == nil {
				// Success
				return &RetryResult{
					Account:       acc,
					Attempt:       accountAttempts - 1,
					TotalAttempts: totalAttempts,
					Success:       true,
				}, nil
			}

			lastErr = err

			// If not retryable, fail fast
			if !shouldRetry {
				return &RetryResult{
					Account:       acc,
					Attempt:       accountAttempts - 1,
					TotalAttempts: totalAttempts,
					Success:       false,
					Error:         err,
				}, err
			}

			// Check if we've exhausted per-account retries
			if accountAttempts >= re.config.MaxPerAccount {
				excludeIDs[acc.ID] = true
				break
			}

			// Check if we've exhausted total retries
			if totalAttempts >= re.config.MaxPerRequest {
				return &RetryResult{
					Account:       acc,
					Attempt:       accountAttempts - 1,
					TotalAttempts: totalAttempts,
					Success:       false,
					Error:         lastErr,
				}, lastErr
			}

			// Backoff before next attempt
			delay := re.config.CalculateBackoff(accountAttempts - 1)
			time.Sleep(delay)
		}

		// Account exhausted, move to next account (no sleep between accounts)
	}

	// All retries exhausted
	return &RetryResult{
		Account:       nil,
		Attempt:       0,
		TotalAttempts: totalAttempts,
		Success:       false,
		Error:         lastErr,
	}, fmt.Errorf("all retries exhausted (%d attempts, %d accounts): %w", totalAttempts, len(excludeIDs)+1, lastErr)
}
