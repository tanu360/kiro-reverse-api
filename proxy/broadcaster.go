package proxy

import (
	"sync"
	"sync/atomic"

	"kiro-proxy/config"
)

// Admin events. Each one tells open admin pages which data to refetch; the
// payload names the changed row, or "*" for many.
const (
	eventAccountsChanged = "accounts_changed"
	eventAPIKeysChanged  = "api_keys_changed"
	eventSettingsChanged = "settings_changed"
	eventStatsReset      = "stats_reset"
	eventBackupCreated   = "backup_created"
	eventBackupRestored  = "backup_restored"
	eventBackupDeleted   = "backup_deleted"
)

func init() {
	//! Every account write goes through config, including background bans and
	//! usage refreshes, so the hook is where no change can be missed.
	config.SetAccountsChangedHook(func(id string) {
		publishEvent(eventAccountsChanged, id)
	})
}

type Event struct {
	Type    string `json:"type"`
	Payload string `json:"payload,omitempty"`
}

type broadcaster struct {
	mu          sync.RWMutex
	subscribers map[uint64]chan Event
	nextID      uint64
}

var (
	defaultBroadcaster *broadcaster
	broadcasterOnce    sync.Once
)

func getBroadcaster() *broadcaster {
	broadcasterOnce.Do(func() {
		defaultBroadcaster = &broadcaster{
			subscribers: make(map[uint64]chan Event),
		}
	})
	return defaultBroadcaster
}

func (b *broadcaster) Subscribe() (uint64, chan Event) {
	id := atomic.AddUint64(&b.nextID, 1)
	ch := make(chan Event, 16)
	b.mu.Lock()
	b.subscribers[id] = ch
	b.mu.Unlock()
	return id, ch
}

func (b *broadcaster) Unsubscribe(id uint64) {
	b.mu.Lock()
	if ch, ok := b.subscribers[id]; ok {
		delete(b.subscribers, id)
		close(ch)
	}
	b.mu.Unlock()
}

func (b *broadcaster) Publish(evt Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.subscribers {
		select {
		case ch <- evt:
		default:

		}
	}
}

func publishObserveTick() {
	getBroadcaster().Publish(Event{Type: "observe_tick"})
}

func publishEvent(eventType, payload string) {
	getBroadcaster().Publish(Event{Type: eventType, Payload: payload})
}
