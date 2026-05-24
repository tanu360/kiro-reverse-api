// Package proxy: SSE broadcaster for admin push notifications.
// 后端发生账号信息变更时，主动推送给所有打开 admin 页面的前端，
// 前端收到事件后立刻拉取最新列表，无需轮询。
package proxy

import (
	"sync"
	"sync/atomic"
)

// Event 推送给前端的事件
type Event struct {
	Type    string `json:"type"`              // 事件类型，如 "account_updated" / "accounts_refreshed"
	Payload string `json:"payload,omitempty"` // 可选载荷，例如 accountID
}

// broadcaster 一个简单的 fan-out hub：所有订阅者通过 channel 接收事件。
// 慢消费者会被丢弃事件（buffered channel + non-blocking send），保护 broadcaster 不被卡死。
type broadcaster struct {
	mu          sync.RWMutex
	subscribers map[uint64]chan Event
	nextID      uint64
}

var (
	defaultBroadcaster *broadcaster
	broadcasterOnce    sync.Once
)

// getBroadcaster 全局单例
func getBroadcaster() *broadcaster {
	broadcasterOnce.Do(func() {
		defaultBroadcaster = &broadcaster{
			subscribers: make(map[uint64]chan Event),
		}
	})
	return defaultBroadcaster
}

// Subscribe 订阅事件，返回事件 channel 和取消函数
func (b *broadcaster) Subscribe() (uint64, chan Event) {
	id := atomic.AddUint64(&b.nextID, 1)
	ch := make(chan Event, 16) // 小 buffer，防瞬时拥塞
	b.mu.Lock()
	b.subscribers[id] = ch
	b.mu.Unlock()
	return id, ch
}

// Unsubscribe 取消订阅
func (b *broadcaster) Unsubscribe(id uint64) {
	b.mu.Lock()
	if ch, ok := b.subscribers[id]; ok {
		delete(b.subscribers, id)
		close(ch)
	}
	b.mu.Unlock()
}

// Publish 发送事件给所有订阅者；订阅者来不及消费就丢弃，不阻塞调用方
func (b *broadcaster) Publish(evt Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.subscribers {
		select {
		case ch <- evt:
		default:
			// 慢消费者直接丢，前端反正是"收到任意事件就重拉"的语义，丢一两个没事
		}
	}
}

// publishAccountUpdated 便捷封装：账号信息已更新
func publishAccountUpdated(accountID string) {
	getBroadcaster().Publish(Event{Type: "account_updated", Payload: accountID})
}

// publishAccountsRefreshed 便捷封装：批量刷新完成
func publishAccountsRefreshed() {
	getBroadcaster().Publish(Event{Type: "accounts_refreshed"})
}

// publishObserveTick 便捷封装：observe 数据周期性 tick
func publishObserveTick() {
	getBroadcaster().Publish(Event{Type: "observe_tick"})
}
