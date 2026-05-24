package pool

import (
	"fmt"
	"kiro-proxy/config"
	"time"
)

type RetryResult struct {
	Account       *config.Account
	Attempt       int
	TotalAttempts int
	Success       bool
	Error         error
}

type RetryExecutor struct {
	pool   *AccountPool
	config RetryConfig
}

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

func (re *RetryExecutor) ExecuteWithRetry(
	model string,
	fn func(acc *config.Account) (shouldRetry bool, err error),
) (*RetryResult, error) {
	excludeIDs := make(map[string]bool)
	totalAttempts := 0
	var lastErr error

	for totalAttempts < re.config.MaxPerRequest {

		acc := re.pool.GetNextForModelExcluding(model, excludeIDs)
		if acc == nil {
			return nil, fmt.Errorf("no available accounts after %d attempts (excluded: %d)", totalAttempts, len(excludeIDs))
		}

		accountAttempts := 0
		for accountAttempts < re.config.MaxPerAccount {
			totalAttempts++
			accountAttempts++

			shouldRetry, err := fn(acc)
			if err == nil {

				return &RetryResult{
					Account:       acc,
					Attempt:       accountAttempts - 1,
					TotalAttempts: totalAttempts,
					Success:       true,
				}, nil
			}

			lastErr = err

			if !shouldRetry {
				return &RetryResult{
					Account:       acc,
					Attempt:       accountAttempts - 1,
					TotalAttempts: totalAttempts,
					Success:       false,
					Error:         err,
				}, err
			}

			if accountAttempts >= re.config.MaxPerAccount {
				excludeIDs[acc.ID] = true
				break
			}

			if totalAttempts >= re.config.MaxPerRequest {
				return &RetryResult{
					Account:       acc,
					Attempt:       accountAttempts - 1,
					TotalAttempts: totalAttempts,
					Success:       false,
					Error:         lastErr,
				}, lastErr
			}

			delay := re.config.CalculateBackoff(accountAttempts - 1)
			time.Sleep(delay)
		}

	}

	return &RetryResult{
		Account:       nil,
		Attempt:       0,
		TotalAttempts: totalAttempts,
		Success:       false,
		Error:         lastErr,
	}, fmt.Errorf("all retries exhausted (%d attempts, %d accounts): %w", totalAttempts, len(excludeIDs)+1, lastErr)
}
