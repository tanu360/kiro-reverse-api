package proxy

import (
	"context"
	"sync"
	"time"

	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
)

// One client request, one start against the per-account RPM limit. The web
// search loop makes several upstream calls for one client request (each model
// round, each MCP search), and every pool pick takes a start. rpmCarry keeps
// such a request at one start: before the next call picks, it gives back the
// start of the call that finished last, and that pick takes it again, on the
// same account or another. Failover inside one call still takes a start per
// account it tries, as for any request.

type rpmCarryKey struct{}

type rpmCarry struct {
	pool  *accountpool.AccountPool
	id    string
	since time.Time
}

// withRPMCarry gives ctx a carry for a request that makes several upstream calls.
func withRPMCarry(ctx context.Context, p *accountpool.AccountPool) context.Context {
	if p == nil {
		return ctx
	}
	return context.WithValue(ctx, rpmCarryKey{}, &rpmCarry{pool: p})
}

// rpmCarryFrom is the request's carry, or nil for a single-call request.
func rpmCarryFrom(ctx context.Context) *rpmCarry {
	if ctx == nil {
		return nil
	}
	c, _ := ctx.Value(rpmCarryKey{}).(*rpmCarry)
	return c
}

// begin runs before a call picks its account: it gives back the start the
// request carries, and returns a time no later than the next pick's start.
func (c *rpmCarry) begin() time.Time {
	now := time.Now()
	if c == nil {
		return now
	}
	if c.id != "" {
		c.pool.ReleaseRPMStart(c.id, c.since)
		c.id = ""
	}
	return now
}

// done records that a call begun at since finished on the account; the
// request now carries that call's start.
func (c *rpmCarry) done(id string, since time.Time) {
	if c == nil || id == "" {
		return
	}
	c.id, c.since = id, since
}

// A try that never reached Kiro still took the start its pick recorded, and
// failover picks every account in turn. With no healthy pool proxy, one failed
// request then leaves each account at its limit, and the next request reads 429
// instead of the outage until a minute has passed, even once a proxy is back.
// rpmPicks remembers when the request picked each account, so the pick's start
// goes back when its last try failed before any connection to Kiro existed.

type rpmPicksKey struct{}

type rpmPicks struct {
	pool  *accountpool.AccountPool
	mu    sync.Mutex
	picks map[string]*rpmPick
}

// rpmPick is one pick of an account by the request. reached marks a try that
// connected to Kiro, which keeps the start; done marks a start given back.
type rpmPick struct {
	since   time.Time
	reached bool
	done    bool
}

// withRPMPicks gives a client request its pick ledger.
func withRPMPicks(ctx context.Context, p *accountpool.AccountPool) context.Context {
	if p == nil {
		return ctx
	}
	return context.WithValue(ctx, rpmPicksKey{}, &rpmPicks{pool: p})
}

// noteRPMPick records that the request picked the account; since is a time
// taken just before the pick, so the pick's start is at or after it.
func noteRPMPick(ctx context.Context, account *config.Account, since time.Time) {
	l, _ := ctx.Value(rpmPicksKey{}).(*rpmPicks)
	if l == nil || account == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.picks == nil {
		l.picks = make(map[string]*rpmPick)
	}
	l.picks[account.ID] = &rpmPick{since: since}
}

// settleRPMPickFailure gives the start of the account's latest pick back when
// err failed before any connection to Kiro, no earlier try of that pick
// connected, and the retry plan will not try the account again for this pick.
// A retried error keeps the start: the retry may still reach Kiro.
func settleRPMPickFailure(ctx context.Context, account *config.Account, err error) {
	l, _ := ctx.Value(rpmPicksKey{}).(*rpmPicks)
	if l == nil || account == nil || err == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	pick := l.picks[account.ID]
	if pick == nil || pick.done {
		return
	}
	if !neverReachedKiro(err) {
		pick.reached = true
		return
	}
	//! The same error reading canRetrySameAccount uses: only an attempt it ends gives the start back.
	if pick.reached || !(isNoHealthyProxyError(err) || isOutboundProxyFailure(err) || isTerminalAccountErrorMessage(err.Error())) {
		return
	}
	pick.done = true
	l.pool.ReleaseRPMStart(account.ID, pick.since)
}
