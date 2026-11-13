package proxy

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

//! Kiro ignores inferenceConfig.maxTokens and has no stop sequences, so a client asking for 100
//! tokens got 3,000 and an "end_turn". The limiter enforces both on what reaches the handler:
//! it counts the output (reasoning, answer and tool calls) with the request estimator, cuts the
//! text where the client's max_tokens runs out or where a stop sequence starts, reports
//! "max_tokens" or "stop_sequence", and cancels the upstream stream so Kiro stops writing.
//!
//! Stop sequences only match the visible answer: text inside an inline <thinking> block and
//! reasoning events pass through unchecked. Tool calls are never cut: a call that starts before
//! the budget runs out is sent whole, and nothing after it is sent once the budget is spent.

type outputLimitsKey struct{}

var errOutputLimitReached = errors.New("output limit reached")

// tokenUnitScale expresses estimateApproxTokens' per-character weights as whole units:
// a letter is 1/4.5 token (4 units), a digit 1/2 (9), a symbol or non-ASCII character 1/1.5 (12).
const tokenUnitScale = 18

func runeTokenUnits(r rune) int {
	switch {
	case r >= 0x80:
		return 12
	case r >= '0' && r <= '9':
		return 9
	case (r >= '!' && r <= '/') || (r >= ':' && r <= '@') || (r >= '[' && r <= '`') || (r >= '{' && r <= '~'):
		return 12
	default:
		return 4
	}
}

const (
	inlineThinkingOpen  = "<thinking>"
	inlineThinkingClose = "</thinking>"
)

type outputLimiter struct {
	maxUnits   int
	stops      []string
	holdBytes  int
	downstream *KiroStreamCallback
	cancel     context.CancelCauseFunc

	usedUnits int
	// pending is answer text held back while it could still be the start of a stop sequence.
	pending       string
	inThinkingTag bool
	forwarded     bool
	// spent is set when a whole tool call used up the budget; any later output ends the turn.
	spent bool

	stopped    bool
	stopReason string
	sequence   string

	upstreamStop          string
	credits               float64
	contextUsage          []float64
	cacheRead, cacheWrite int
	sawCache              bool
	inputTokens           int
	outputTokens          int
	sawComplete           bool
}

// newOutputLimiter returns nil when the request sets neither limit, or when an outer call
// already enforces them (structured output and auto-continue call back into the same entry).
func newOutputLimiter(ctx context.Context, payload *KiroPayload, callback *KiroStreamCallback) *outputLimiter {
	if payload == nil || callback == nil || ctx.Value(outputLimitsKey{}) != nil {
		return nil
	}
	stops := make([]string, 0, len(payload.StopSequences))
	for _, s := range payload.StopSequences {
		if s != "" {
			stops = append(stops, s)
		}
	}
	maxTokens := requestedMaxTokens(payload)
	if maxTokens <= 0 && len(stops) == 0 {
		return nil
	}
	hold := 0
	if len(stops) > 0 {
		hold = len(inlineThinkingClose) - 1
		for _, s := range stops {
			hold = max(hold, len(s)-1)
		}
	}
	return &outputLimiter{
		maxUnits:   max(maxTokens, 0) * tokenUnitScale,
		stops:      stops,
		holdBytes:  hold,
		downstream: callback,
	}
}

// run calls Kiro through the limiter. A stream it cancelled at a limit ends as a normal reply.
func (l *outputLimiter) run(ctx context.Context, call func(context.Context, *KiroStreamCallback) error) error {
	inner, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	l.cancel = cancel
	err := call(context.WithValue(inner, outputLimitsKey{}, true), l.callback())
	if l.stopped {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		l.finish()
		return nil
	}
	if err != nil {
		//! Text held for a possible stop sequence was part of the answer; the client already
		//! holds what came before it. Before any output the caller retries, so it is dropped.
		if l.forwarded && l.pending != "" {
			l.forwardRaw(l.pending)
		}
		l.pending = ""
		return err
	}
	l.drain(true)
	l.finish()
	return nil
}

func (l *outputLimiter) callback() *KiroStreamCallback {
	cb := *l.downstream
	cb.OnText = func(text string, isThinking bool) {
		if l.stopped || text == "" {
			return
		}
		if l.spent {
			l.stop("max_tokens", "")
			return
		}
		if isThinking || len(l.stops) == 0 {
			l.forwardCounted(text, isThinking)
			return
		}
		l.pending += text
		l.drain(false)
	}
	if l.downstream.OnToolUse != nil {
		cb.OnToolUse = func(toolUse KiroToolUse) {
			if l.stopped {
				return
			}
			//! A stop sequence in the text before a call ends the turn before the call.
			l.drain(true)
			if l.stopped {
				return
			}
			if l.spent || (l.maxUnits > 0 && l.usedUnits >= l.maxUnits) {
				l.stop("max_tokens", "")
				return
			}
			l.usedUnits += (estimateApproxTokens(toolUse.Name) + estimateJSONTokens(toolUse.Input)) * tokenUnitScale
			l.forwarded = true
			l.downstream.OnToolUse(toolUse)
			if l.maxUnits > 0 && l.usedUnits >= l.maxUnits {
				l.spent = true
			}
		}
	}
	if l.downstream.OnThinkingSignature != nil {
		cb.OnThinkingSignature = func(signature string) {
			if !l.stopped {
				l.downstream.OnThinkingSignature(signature)
			}
		}
	}
	if l.downstream.OnRedactedThinking != nil {
		cb.OnRedactedThinking = func(data string) {
			if l.stopped {
				return
			}
			l.drain(true)
			if !l.stopped {
				l.forwarded = true
				l.downstream.OnRedactedThinking(data)
			}
		}
	}
	cb.OnStopReason = func(reason string) { l.upstreamStop = reason }
	cb.OnCredits = func(credits float64) { l.credits += credits }
	cb.OnContextUsage = func(percentage float64) { l.contextUsage = append(l.contextUsage, percentage) }
	cb.OnCacheUsage = func(read, write int) { l.cacheRead, l.cacheWrite, l.sawCache = read, write, true }
	cb.OnComplete = func(inputTokens, outputTokens int) {
		l.inputTokens, l.outputTokens, l.sawComplete = inputTokens, outputTokens, true
	}
	return &cb
}

// drain forwards held answer text that can no longer start a stop sequence; final releases the rest.
func (l *outputLimiter) drain(final bool) {
	for l.pending != "" && !l.stopped {
		if l.inThinkingTag {
			if i := strings.Index(l.pending, inlineThinkingClose); i >= 0 {
				end := i + len(inlineThinkingClose)
				l.forwardCounted(l.pending[:end], false)
				l.pending = l.pending[end:]
				l.inThinkingTag = false
				continue
			}
			l.release(final, len(inlineThinkingClose)-1)
			return
		}
		at, sequence := l.firstStop(l.pending)
		tag := strings.Index(l.pending, inlineThinkingOpen)
		if at >= 0 && (tag < 0 || at < tag) {
			l.forwardCounted(l.pending[:at], false)
			l.pending = ""
			if !l.stopped {
				l.stop("stop_sequence", sequence)
			}
			return
		}
		if tag >= 0 {
			end := tag + len(inlineThinkingOpen)
			l.forwardCounted(l.pending[:end], false)
			l.pending = l.pending[end:]
			l.inThinkingTag = true
			continue
		}
		l.release(final, l.holdBytes)
		return
	}
}

// release forwards pending text except its last hold bytes, cut on a character boundary.
func (l *outputLimiter) release(final bool, hold int) {
	n := len(l.pending)
	if !final {
		n = max(n-hold, 0)
		for n > 0 && n < len(l.pending) && !utf8.RuneStart(l.pending[n]) {
			n--
		}
	}
	if n == 0 {
		return
	}
	text := l.pending[:n]
	l.pending = l.pending[n:]
	l.forwardCounted(text, false)
}

func (l *outputLimiter) firstStop(text string) (int, string) {
	best, sequence := -1, ""
	for _, s := range l.stops {
		if i := strings.Index(text, s); i >= 0 && (best < 0 || i < best) {
			best, sequence = i, s
		}
	}
	return best, sequence
}

// forwardCounted sends text on, cut where the token budget runs out.
func (l *outputLimiter) forwardCounted(text string, isThinking bool) {
	if text == "" || l.stopped {
		return
	}
	if l.maxUnits > 0 {
		for i, r := range text {
			units := runeTokenUnits(r)
			if l.usedUnits+units > l.maxUnits {
				l.send(text[:i], isThinking)
				l.stop("max_tokens", "")
				return
			}
			l.usedUnits += units
		}
	} else {
		for _, r := range text {
			l.usedUnits += runeTokenUnits(r)
		}
	}
	l.send(text, isThinking)
}

// forwardRaw sends text without counting it; only for text the client must not lose on an error.
func (l *outputLimiter) forwardRaw(text string) {
	l.send(text, false)
}

func (l *outputLimiter) send(text string, isThinking bool) {
	if text == "" || l.downstream.OnText == nil {
		return
	}
	l.forwarded = true
	l.downstream.OnText(text, isThinking)
}

func (l *outputLimiter) stop(reason, sequence string) {
	l.stopped = true
	l.stopReason = reason
	l.sequence = sequence
	l.pending = ""
	if l.cancel != nil {
		l.cancel(errOutputLimitReached)
	}
}

func (l *outputLimiter) usedTokens() int {
	return (l.usedUnits + tokenUnitScale - 1) / tokenUnitScale
}

// finish hands the turn's end to the handler: the limit's stop reason, and the output counted
// here when the stream was cut, since Kiro's own count never arrived or covers text not sent.
func (l *outputLimiter) finish() {
	d := l.downstream
	reason := l.upstreamStop
	outputTokens := l.outputTokens
	if l.stopped {
		reason = l.stopReason
		outputTokens = l.usedTokens()
	}
	if d.OnStopReason != nil {
		d.OnStopReason(reason)
	}
	if l.stopped && l.stopReason == "stop_sequence" && d.OnStopSequence != nil {
		d.OnStopSequence(l.sequence)
	}
	if d.OnCredits != nil && l.credits > 0 {
		d.OnCredits(l.credits)
	}
	if d.OnContextUsage != nil {
		for _, percentage := range l.contextUsage {
			d.OnContextUsage(percentage)
		}
	}
	if d.OnCacheUsage != nil && l.sawCache {
		d.OnCacheUsage(l.cacheRead, l.cacheWrite)
	}
	if d.OnComplete != nil && (l.sawComplete || l.stopped) {
		d.OnComplete(l.inputTokens, outputTokens)
	}
}

// claudeStopSequence is the Messages API's stop_sequence field: the matched sequence, or null.
func claudeStopSequence(stopReason string, sequence *string) *string {
	if stopReason != "stop_sequence" {
		return nil
	}
	return sequence
}
