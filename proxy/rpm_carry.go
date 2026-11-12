package proxy

import (
	"context"
	"time"

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
