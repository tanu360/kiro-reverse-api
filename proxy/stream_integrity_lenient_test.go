package proxy

import (
	"errors"
	"testing"
)

// Lenient mode only widens the one case IdC/Enterprise accounts hit: answer text
// with no stop reason and no metering. Everything else must classify identically
// with the flag on or off.
func TestClassifyStreamIntegrityLenientMode(t *testing.T) {
	for _, tc := range []struct {
		name    string
		turn    streamTurnSignals
		strict  error
		lenient error
	}{
		{
			name:    "answer only",
			turn:    streamTurnSignals{sawContent: true},
			strict:  errUpstreamTruncatedResponse,
			lenient: nil,
		},
		{
			name:    "nothing at all",
			turn:    streamTurnSignals{},
			strict:  errEmptyKiroStream,
			lenient: errEmptyKiroStream,
		},
		{
			name:    "reasoning without answer stays truncated",
			turn:    streamTurnSignals{sawReasoning: true},
			strict:  errUpstreamTruncatedResponse,
			lenient: errUpstreamTruncatedResponse,
		},
		{
			name:    "reasoning plus answer without metering stays truncated",
			turn:    streamTurnSignals{sawContent: true, sawReasoning: true},
			strict:  errUpstreamTruncatedResponse,
			lenient: errUpstreamTruncatedResponse,
		},
		{
			name:    "stop reason completes the turn",
			turn:    streamTurnSignals{sawContent: true, stopReason: "end_turn"},
			strict:  nil,
			lenient: nil,
		},
		{
			name:    "metering completes the turn",
			turn:    streamTurnSignals{sawContent: true, sawTrailer: true},
			strict:  nil,
			lenient: nil,
		},
		{
			name:    "tool use completes the turn",
			turn:    streamTurnSignals{toolCount: 1},
			strict:  nil,
			lenient: nil,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyStreamIntegrity(tc.turn, false); !errors.Is(got, tc.strict) {
				t.Fatalf("strict: got %v, want %v", got, tc.strict)
			}
			if got := classifyStreamIntegrity(tc.turn, true); !errors.Is(got, tc.lenient) {
				t.Fatalf("lenient: got %v, want %v", got, tc.lenient)
			}
		})
	}
}

// The default must stay strict: a stream cut mid-answer leaves the same signals
// as a complete one on these accounts, and silently serving it is worse.
func TestStreamIntegrityDefaultsToStrict(t *testing.T) {
	if err := classifyStreamIntegrity(streamTurnSignals{sawContent: true}, false); err == nil {
		t.Fatal("answer without metering accepted in strict mode")
	}
}
