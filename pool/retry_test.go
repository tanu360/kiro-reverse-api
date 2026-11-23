package pool

import (
	"testing"
	"time"
)

// maxRetriesPerRequest has no upper bound, so a pool of many accounts can reach attempts where
// doubling the base delay overflows int64. The delay must stay at its cap, not wrap to zero.
func TestCalculateBackoffStaysAtTheCapForLargeAttempts(t *testing.T) {
	rc := RetryConfig{BaseDelay: 100 * time.Millisecond, MaxDelay: 5 * time.Second}
	for _, attempt := range []int{6, 37, 40, 62, 63, 64, 100} {
		for i := 0; i < 20; i++ {
			if got := rc.CalculateBackoff(attempt); got < rc.MaxDelay/2 || got > rc.MaxDelay*3/2 {
				t.Fatalf("attempt %d: backoff %v, want %v give or take half", attempt, got, rc.MaxDelay)
			}
		}
	}
	if got := rc.CalculateBackoff(0); got < 50*time.Millisecond || got > 150*time.Millisecond {
		t.Fatalf("attempt 0: backoff %v, want about the base delay", got)
	}
}
