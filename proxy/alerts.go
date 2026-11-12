package proxy

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

/*
 * Outbound alerts. The rules (alerts_rules.go) run after each usage refresh
 * sweep and after account changes, never on the request path: refreshAllAccounts
 * kicks the alerter, and every accounts_changed event (bans, cooldowns, usage
 * updates) does too. Kicks are debounced, and a slow safety tick catches
 * cooldowns that run out without an event. Messages go through one queue to a
 * sender goroutine, so a slow or broken channel never holds up an evaluation.
 */

const (
	// alertSafetyTick re-evaluates without a kick: cooldowns expire silently.
	alertSafetyTick = 5 * time.Minute
	// alertDebounceQuiet is how long kicks must stop before an evaluation runs.
	alertDebounceQuiet = 3 * time.Second
	// alertDebounceMax caps how long a stream of kicks can hold one off.
	alertDebounceMax = 30 * time.Second
	// alertQueueSize is how many messages may wait for the sender.
	alertQueueSize = 32
)

// alertKick wakes the alerter; one pending kick is enough.
var alertKick = make(chan struct{}, 1)

// kickAlerts asks for an evaluation soon. It never blocks.
func kickAlerts() {
	select {
	case alertKick <- struct{}{}:
	default:
	}
}

type alerter struct {
	queue chan alertMessage

	// evalMu serializes evaluations; it guards unavailableSince.
	evalMu sync.Mutex
	// unavailableSince is when the pool was first seen with no account able to
	// serve (0 = it can serve). In memory only: a restart starts the grace again.
	unavailableSince int64
}

var (
	alertsOnce    sync.Once
	defaultAlerts *alerter
)

func getAlerter() *alerter {
	alertsOnce.Do(func() {
		defaultAlerts = newAlerter()
	})
	return defaultAlerts
}

func newAlerter() *alerter {
	return &alerter{queue: make(chan alertMessage, alertQueueSize)}
}

// evaluate runs every switched-on rule over accounts and returns the messages
// to send. Each rule's dedup and cooldown state is read from and written to
// alert_state before anything is sent: a message counts as sent once queued,
// so a channel that keeps failing cannot cause a resend storm. wait > 0 asks
// for another evaluation after that long (an outage still in its grace).
// Nothing is evaluated, and no state used up, while no channel is enabled.
func (a *alerter) evaluate(cfg config.AlertsConfig, accounts []config.Account, enabled, available int, now int64) (msgs []alertMessage, wait time.Duration, err error) {
	a.evalMu.Lock()
	defer a.evalMu.Unlock()
	if len(cfg.EnabledChannels()) == 0 {
		a.unavailableSince = 0
		return nil, 0, nil
	}
	states, err := loadAlertStates()
	if err != nil {
		return nil, 0, err
	}
	changed := make(map[string]alertState)
	put := func(key string, next alertState) {
		if next != states[key] {
			changed[key] = next
		}
	}
	cooldown := time.Duration(cfg.PoolCooldownMinutes) * time.Minute

	live := make(map[string]bool, len(accounts))
	for _, acc := range accounts {
		live[acc.ID] = true
		if cfg.AccountUsageOn() && alertUsageEligible(acc) {
			key := alertKeyAccountPrefix + acc.ID
			send, next := evalAccountUsage(acc, cfg.AccountThresholds, states[key], now)
			put(key, next)
			if send > 0 {
				msgs = append(msgs, accountUsageMessage(acc, send, now))
			}
		}
		if cfg.AccountBannedOn() {
			key := alertKeyBannedPrefix + acc.ID
			send, next := evalBanned(acc, states[key], now)
			put(key, next)
			if send {
				msgs = append(msgs, bannedMessage(acc, now))
			}
		}
	}

	if cfg.PoolUsageOn() {
		if used, limit, n := poolUsage(accounts); n > 0 && limit > 0 {
			send, next := evalPoolUsage(used/limit*100, cfg.PoolThresholds, cooldown, states[alertKeyPool], now)
			put(alertKeyPool, next)
			if send > 0 {
				msgs = append(msgs, poolUsageMessage(used, limit, n, send, now))
			}
		}
	}

	if cfg.AllUnavailableOn() {
		send, since, next, recheck := evalAllUnavailable(enabled, available, a.unavailableSince, cooldown, states[alertKeyAllUnavailable], now)
		a.unavailableSince = since
		put(alertKeyAllUnavailable, next)
		wait = recheck
		if send {
			msgs = append(msgs, allUnavailableMessage(enabled, since, now))
		}
	} else {
		a.unavailableSince = 0
	}

	// Rows of deleted accounts go; an empty list is more likely a load glitch than a wipe.
	var drop []string
	if len(accounts) > 0 {
		for key := range states {
			for _, prefix := range []string{alertKeyAccountPrefix, alertKeyBannedPrefix} {
				if id, ok := strings.CutPrefix(key, prefix); ok && !live[id] {
					drop = append(drop, key)
				}
			}
		}
	}
	if err := saveAlertStates(changed, drop); err != nil {
		//! No state saved, nothing sent: the next evaluation decides again instead of sending twice.
		return nil, wait, err
	}
	return msgs, wait, nil
}

// enqueue hands messages to the sender. A full queue drops the message: the
// alerter must never block an evaluation on a slow channel.
func (a *alerter) enqueue(msgs []alertMessage) {
	for _, msg := range msgs {
		select {
		case a.queue <- msg:
		default:
			logger.Warnf("[Alerts] Send queue full, dropped a %s alert", msg.Event)
		}
	}
}

// run sends queued messages until ctx ends. Each message goes to every enabled
// channel at once; the channel list is read at send time, so an edit or a
// disabled channel applies to messages already queued.
func (a *alerter) run(ctx context.Context, client func() *http.Client) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-a.queue:
			channels := config.GetAlertsConfig().EnabledChannels()
			if len(channels) == 0 {
				continue
			}
			var wg sync.WaitGroup
			for _, ch := range channels {
				wg.Go(func() {
					a.deliver(ctx, client(), ch, msg, alertRetries)
				})
			}
			wg.Wait()
			publishEvent(eventSettingsChanged, "alerts")
		}
	}
}

// deliver sends msg to ch and stores the result as the channel's last one.
func (a *alerter) deliver(ctx context.Context, client *http.Client, ch config.AlertChannel, msg alertMessage, retries int) alertDelivery {
	result := sendAlert(ctx, client, ch, msg, retries)
	if err := recordAlertDelivery(ch.ID, result); err != nil {
		logger.Warnf("[Alerts] Failed to store the result for %s channel %q: %v", ch.Type, ch.Name, err)
	}
	//! Only the channel's type and name: its URL and token are secrets, and so may be the error.
	if result.OK {
		logger.Infof("[Alerts] Sent %s alert to %s channel %q (%d attempts)", msg.Event, ch.Type, ch.Name, result.Attempts)
	} else {
		logger.Warnf("[Alerts] %s alert to %s channel %q failed after %d attempts (status %d)", msg.Event, ch.Type, ch.Name, result.Attempts, result.Status)
	}
	return result
}

// evaluateAlerts runs the rules over the live accounts and queues what they
// decide. It returns when to re-check, 0 for the regular schedule.
func (h *Handler) evaluateAlerts(now time.Time) time.Duration {
	a := getAlerter()
	cfg := config.GetAlertsConfig()
	var enabled, available int
	if len(cfg.EnabledChannels()) > 0 {
		enabled, available = h.accountAvailabilityNow()
	}
	msgs, wait, err := a.evaluate(cfg, config.GetAccounts(), enabled, available, now.Unix())
	if err != nil {
		logger.Warnf("[Alerts] Evaluation failed: %v", err)
		return wait
	}
	a.enqueue(msgs)
	return wait
}

// backgroundAlerts is the alerter's loop: it collects kicks and account
// events, debounces them into evaluations, and runs the sender.
func (h *Handler) backgroundAlerts() {
	a := getAlerter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.run(ctx, alertHTTPClient)

	b := getBroadcaster()
	subID, events := b.Subscribe()
	defer b.Unsubscribe(subID)

	safety := time.NewTicker(alertSafetyTick)
	defer safety.Stop()
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	var firstKick time.Time
	armed := false
	arm := func(d time.Duration) {
		timer.Stop()
		timer.Reset(max(d, 0))
		armed = true
	}
	kick := func() {
		now := time.Now()
		if firstKick.IsZero() {
			firstKick = now
		}
		arm(min(alertDebounceQuiet, firstKick.Add(alertDebounceMax).Sub(now)))
	}
	evaluate := func() {
		firstKick = time.Time{}
		armed = false
		if wait := h.evaluateAlerts(time.Now()); wait > 0 {
			arm(wait)
		}
	}

	for {
		var due <-chan time.Time
		if armed {
			due = timer.C
		}
		select {
		case <-h.stopRefresh:
			return
		case evt, ok := <-events:
			if !ok {
				return
			}
			if evt.Type == eventAccountsChanged {
				kick()
			}
		case <-alertKick:
			kick()
		case <-due:
			evaluate()
		case <-safety.C:
			evaluate()
		}
	}
}
