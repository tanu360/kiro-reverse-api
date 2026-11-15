package proxy

import (
	"context"
	"errors"
	"io"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/pool"
)

//! The output limiter cancels Kiro's stream where it cuts a reply (max_tokens or a stop
//! sequence), before the billing event at its end (meteringEvent; CreateResponse's
//! response.completed). Live (2026-11-15, claude-haiku-4.5, both chat APIs): 16 replies cut
//! while Kiro was still writing them, early (20 of ~1515 tokens) or late (1200), were billed
//! nothing, while each uncut one cost ~0.07 credits. 4 replies cut by a stop sequence in their
//! last words were billed in full (~0.07 each) but logged with 0. Kiro bills a reply only when
//! it finished writing it before the cancel reached it.
//!
//! So the stream is still closed soon after the cut: reading a cut reply to its end would have
//! Kiro finish it (~3 s more for a 1515-token reply cut at 20) and bill all of it. But not at
//! once: events already received are still read (cutInHandWait), the client's response ends,
//! and the stream is read on in the background for at most cutBillingGrace. That catches the
//! billing event of a reply Kiro had already finished (it follows the last text by ~40 ms on
//! generateAssistantResponse, ~100 ms on CreateResponse), and its credits are added where the
//! request was counted: its log row, the account, the API key and the windows. Live with this,
//! 8 such replies logged 0.66 credits where Kiro billed 0.66, and 20 cut early still cost 0.

// cutBillingGrace is how long a cut stream is read for its billing event before it is closed.
var cutBillingGrace = 500 * time.Millisecond

// errStreamCut ends consumeKiroEvents at an output limit cut (cutReader): the stream is handed
// to drainCutStream instead of being closed.
var errStreamCut = errors.New("stream cut at an output limit")

// errCutGraceOver closes a cut stream whose billing event did not arrive in cutBillingGrace.
var errCutGraceOver = errors.New("cut stream closed after the billing grace")

// isOutputLimitCut reports whether ctx ended because the output limiter cut the reply.
func isOutputLimitCut(ctx context.Context) bool {
	return ctx.Err() != nil && errors.Is(context.Cause(ctx), errOutputLimitReached)
}

// upstreamStreamContext is the context for one upstream chat request made under ctx. It ends
// when ctx does, except when ctx ends at an output limit cut: the stream then stays open until
// end is called, so drainCutStream can read on for the reply's billing event. The caller calls
// end (nil cause) when it is done with the stream, unless drainCutStream took it over.
func upstreamStreamContext(ctx context.Context) (stream context.Context, end context.CancelCauseFunc) {
	stream, cancel := context.WithCancelCause(context.WithoutCancel(ctx))
	stop := context.AfterFunc(ctx, func() {
		if !isOutputLimitCut(ctx) {
			cancel(context.Cause(ctx))
		}
	})
	return stream, func(cause error) {
		stop()
		cancel(cause)
	}
}

// cutReader reads a stream's events for consumeKiroEvents. Once the output limiter has cut the
// reply it passes on only what arrives within cutInHandWait of the cut, such as Kiro's context
// count already in hand, and then ends the stream for its caller with errStreamCut; a read
// still waiting is left in pending for drainCutStream.
type cutReader struct {
	ctx     context.Context
	events  kiroEventSource
	cutAt   time.Time
	pending chan cutRead
}

type cutRead struct {
	event kiroStreamEvent
	err   error
}

// cutInHandWait is how long after a cut the stream is still read before the client's response
// ends: events already received are passed on, a read that has to wait for Kiro is not.
var cutInHandWait = 20 * time.Millisecond

func newCutReader(ctx context.Context, events kiroEventSource) *cutReader {
	return &cutReader{ctx: ctx, events: events}
}

func (r *cutReader) next() (kiroStreamEvent, error) {
	if !isOutputLimitCut(r.ctx) {
		return r.events()
	}
	if r.cutAt.IsZero() {
		r.cutAt = time.Now()
	}
	read := make(chan cutRead, 1)
	go func() {
		event, err := r.events()
		read <- cutRead{event: event, err: err}
	}()
	timer := time.NewTimer(max(time.Until(r.cutAt.Add(cutInHandWait)), 0))
	defer timer.Stop()
	select {
	case got := <-read:
		return got.event, got.err
	case <-timer.C:
		r.pending = read
		return kiroStreamEvent{}, errStreamCut
	}
}

// drainCutStream takes over a stream cutReader ended at a cut: it reads the rest of the events
// in the background, for at most cutBillingGrace, and counts the credits of a billing event
// among them on the request (requestTrace.addLateCredits). It closes body and ends the stream
// either way. Without a request to count them on, the stream is closed at once.
func drainCutStream(ctx context.Context, account *config.Account, reader *cutReader, body io.Closer, end context.CancelCauseFunc) {
	trace := requestTraceFromContext(ctx)
	closeStream := func(cause error) {
		end(cause)
		//! Closing the body too unblocks a read the cancel alone would not.
		_ = body.Close()
	}
	if trace == nil {
		closeStream(errCutGraceOver)
		return
	}
	accountID := ""
	if account != nil {
		accountID = account.ID
	}
	cutAt := time.Now()
	timer := time.AfterFunc(cutBillingGrace, func() { closeStream(errCutGraceOver) })
	go func() {
		defer func() {
			timer.Stop()
			closeStream(nil)
		}()
		credits := 0.0
		for {
			var next kiroStreamEvent
			var err error
			if reader.pending != nil {
				got := <-reader.pending
				reader.pending = nil
				next, err = got.event, got.err
			} else {
				next, err = reader.events()
			}
			if err != nil {
				break
			}
			if next.Type == "meteringEvent" {
				if usage, ok := next.Event["usage"].(float64); ok && usage > 0 {
					credits += usage
				}
			}
		}
		if credits <= 0 {
			logger.Debugf("[KiroAPI] Cut reply: no billing event within %s", time.Since(cutAt).Round(time.Millisecond))
			return
		}
		logger.Infof("[KiroAPI] Cut reply billed %.4f credits, %s after the cut", credits, time.Since(cutAt).Round(time.Millisecond))
		trace.addLateCredits(accountID, credits)
	}()
}

// lateCredit is credits an account was billed for a request after its response ended.
type lateCredit struct {
	accountID string
	credits   float64
}

// addLateCredits counts credits accountID was billed for the request after its response ended:
// at once if the request is already logged, else as soon as it is (onLateCredits).
func (t *requestTrace) addLateCredits(accountID string, credits float64) {
	if t == nil || credits <= 0 {
		return
	}
	t.lateMu.Lock()
	apply := t.lateApply
	if apply == nil {
		t.latePending = append(t.latePending, lateCredit{accountID: accountID, credits: credits})
	}
	t.lateMu.Unlock()
	if apply != nil {
		apply(accountID, credits)
	}
}

// onLateCredits sets where late credits are counted once the request is logged, and counts
// those that arrived before.
func (t *requestTrace) onLateCredits(apply func(accountID string, credits float64)) {
	if t == nil {
		return
	}
	t.lateMu.Lock()
	t.lateApply = apply
	pending := t.latePending
	t.latePending = nil
	t.lateMu.Unlock()
	for _, c := range pending {
		apply(c.accountID, c.credits)
	}
}

// lateCreditsApplier counts late credits where the logged request rec was counted: its row,
// the observe windows, model stats and /metrics, the account that was billed and the API key.
func lateCreditsApplier(s *observeStore, rec requestRecord) func(accountID string, credits float64) {
	return func(accountID string, credits float64) {
		if accountID == "" {
			accountID = rec.AccountID
		}
		pool.GetPool().AddUsage(accountID, 0, credits)
		if rec.APIKeyID != "" {
			if err := config.AddApiKeyCredits(rec.APIKeyID, credits); err != nil && !errors.Is(err, config.ErrApiKeyNotFound) {
				logger.Warnf("[ApiKey] failed to add late credits for key %s: %v", rec.APIKeyID, err)
			}
		}
		//! The row last: once the request log shows the credits, every total has them.
		s.addLateCredits(rec, credits)
	}
}

// addLateCredits adds credits billed after rec was logged to its row, the minute windows and
// model stats that counted it, and /metrics.
func (s *observeStore) addLateCredits(rec requestRecord, credits float64) {
	if s == nil || credits <= 0 {
		return
	}
	recordLateCreditsMetric(rec, credits)
	slot, curMin := curSlot(rec.TS)
	s.mu.Lock()
	if rec.ID > 0 {
		for i := range s.recentRequests {
			if s.recentRequests[i].ID == rec.ID {
				s.recentRequests[i].Credits += credits
			}
		}
	}
	if b := &s.globalRing[slot]; b.WindowMin == curMin {
		b.Credits += credits
	}
	if ring, ok := s.accountRings[rec.AccountID]; ok && rec.AccountID != "" {
		if b := &ring[slot]; b.WindowMin == curMin {
			b.Credits += credits
		}
	}
	if rec.Model != "" && rec.AccountID != "" {
		if ms, ok := s.modelStats[rec.Model]; ok {
			ms.Credits += credits
		}
	}
	s.mu.Unlock()
	if rec.ID > 0 {
		if err := addPersistedRequestCredits(rec.ID, credits); err != nil {
			logger.Warnf("[Observe] Adding late credits to request %d failed: %v", rec.ID, err)
		}
	}
	s.seq.Add(1)
}
