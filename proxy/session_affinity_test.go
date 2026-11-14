package proxy

import (
	"context"
	"fmt"
	"kiro-proxy/config"
	"kiro-proxy/pool"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSessionAffinityBindAndLookup(t *testing.T) {
	s := newSessionAffinity()
	if got := s.Lookup("conv"); got != "" {
		t.Fatalf("unbound key returned %q", got)
	}
	s.Bind("conv", "acct-1")
	if got := s.Lookup("conv"); got != "acct-1" {
		t.Fatalf("Lookup = %q, want acct-1", got)
	}
	s.Bind("conv", "acct-2")
	if got := s.Lookup("conv"); got != "acct-2" {
		t.Fatalf("rebind: Lookup = %q, want acct-2", got)
	}
}

func TestSessionAffinityIgnoresEmptyInputs(t *testing.T) {
	s := newSessionAffinity()
	s.Bind("", "acct")
	s.Bind("conv", "")
	if len(s.entries) != 0 {
		t.Fatalf("empty key or account created %d bindings", len(s.entries))
	}

	var nilStore *sessionAffinity
	nilStore.Bind("conv", "acct")
	if got := nilStore.Lookup("conv"); got != "" {
		t.Fatalf("nil store returned %q", got)
	}
}

func TestSessionAffinityExpires(t *testing.T) {
	s := newSessionAffinity()
	s.entries["conv"] = sessionAffinityEntry{accountID: "acct", expiresAt: time.Now().Add(-time.Second)}
	if got := s.Lookup("conv"); got != "" {
		t.Fatalf("expired binding returned %q", got)
	}
	if _, ok := s.entries["conv"]; ok {
		t.Fatal("expired binding was not removed on lookup")
	}
}

// A client that opens a new conversation on every request must not grow the
// map without bound.
func TestSessionAffinityStaysBounded(t *testing.T) {
	s := newSessionAffinity()
	for i := 0; i < maxSessionAffinityEntries*2; i++ {
		s.Bind(fmt.Sprintf("conv-%d", i), "acct")
	}
	if len(s.entries) > maxSessionAffinityEntries {
		t.Fatalf("map holds %d entries, cap is %d", len(s.entries), maxSessionAffinityEntries)
	}
	last := fmt.Sprintf("conv-%d", maxSessionAffinityEntries*2-1)
	if got := s.Lookup(last); got != "acct" {
		t.Fatalf("newest binding was evicted: Lookup = %q", got)
	}
}

func TestSessionAffinityEvictsExpiredFirst(t *testing.T) {
	s := newSessionAffinity()
	past := time.Now().Add(-time.Second)
	for i := 0; i < maxSessionAffinityEntries; i++ {
		s.entries[fmt.Sprintf("old-%d", i)] = sessionAffinityEntry{accountID: "acct", expiresAt: past}
	}
	s.entries["live"] = sessionAffinityEntry{accountID: "acct", expiresAt: time.Now().Add(time.Hour)}

	s.Bind("new", "acct")

	if got := s.Lookup("live"); got != "acct" {
		t.Fatal("a live binding was evicted while expired ones were available")
	}
	if len(s.entries) != 2 {
		t.Fatalf("map holds %d entries after pruning, want 2", len(s.entries))
	}
}

func affinityTestHandler(t *testing.T, ids ...string) *Handler {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, id := range ids {
		if err := config.AddAccount(config.Account{ID: id, Email: id + "@example.com", Enabled: true}); err != nil {
			t.Fatalf("AddAccount: %v", err)
		}
	}
	p := pool.GetPool()
	p.Reload()
	return &Handler{pool: p, affinity: newSessionAffinity()}
}

func payloadFor(conversationID string) *KiroPayload {
	payload := &KiroPayload{}
	payload.ConversationState.ConversationID = conversationID
	return payload
}

// The feature end to end: a conversation's follow-up turns land on the account
// that served its first turn, while a new conversation still rotates.
func TestPickAccountKeepsConversationOnServingAccount(t *testing.T) {
	h := affinityTestHandler(t, "aff-a", "aff-b", "aff-c")
	convA := payloadFor("conversation-a")

	first := h.pickAccount(context.Background(), convA, "", nil)
	if first == nil {
		t.Fatal("no account picked")
	}
	h.rememberAccount(context.Background(), convA, first)

	for turn := 0; turn < 5; turn++ {
		if acc := h.pickAccount(context.Background(), convA, "", nil); acc == nil || acc.ID != first.ID {
			t.Fatalf("turn %d went to %v, want %s", turn, acc, first.ID)
		}
	}

	other := h.pickAccount(context.Background(), payloadFor("conversation-b"), "", nil)
	if other == nil || other.ID == first.ID {
		t.Fatalf("new conversation landed on %v; rotation should move past %s", other, first.ID)
	}
}

func TestPickAccountRotatesWhenAffinityDisabled(t *testing.T) {
	h := affinityTestHandler(t, "aff-a", "aff-b")
	if err := config.UpdateSessionAffinity(false); err != nil {
		t.Fatalf("UpdateSessionAffinity: %v", err)
	}
	conv := payloadFor("conversation")

	first := h.pickAccount(context.Background(), conv, "", nil)
	h.rememberAccount(context.Background(), conv, first)
	second := h.pickAccount(context.Background(), conv, "", nil)
	if first.ID == second.ID {
		t.Fatalf("affinity off but both turns went to %s", first.ID)
	}
	if len(h.affinity.entries) != 0 {
		t.Fatal("affinity off but a binding was stored")
	}
}

// Failover inside one request: once the bound account failed and was
// excluded, the retry must go elsewhere, and the success rebinds.
func TestPickAccountFailsOverAndRebinds(t *testing.T) {
	h := affinityTestHandler(t, "aff-a", "aff-b")
	conv := payloadFor("conversation")
	h.affinity.Bind(affinityKey(conv), "aff-a")

	retry := h.pickAccount(context.Background(), conv, "", map[string]bool{"aff-a": true})
	if retry == nil || retry.ID != "aff-b" {
		t.Fatalf("retry went to %v, want aff-b", retry)
	}
	h.rememberAccount(context.Background(), conv, retry)
	if got := h.affinity.Lookup(affinityKey(conv)); got != "aff-b" {
		t.Fatalf("binding after failover = %q, want aff-b", got)
	}
}

func TestSessionAffinityDefaultsOn(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if !config.GetSessionAffinity() {
		t.Fatal("session affinity must be on for a fresh install")
	}
}

// priorityAffinityHandler is affinityTestHandler in priority routing mode with
// prio-top at priority 0 and prio-low at priority 3.
func priorityAffinityHandler(t *testing.T) *Handler {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, acc := range []config.Account{
		{ID: "prio-low", Email: "prio-low@example.com", Enabled: true, Priority: 3},
		{ID: "prio-top", Email: "prio-top@example.com", Enabled: true, Priority: 0},
	} {
		if err := config.AddAccount(acc); err != nil {
			t.Fatalf("AddAccount: %v", err)
		}
	}
	if err := config.UpdateRoutingMode(config.RoutingModePriority); err != nil {
		t.Fatalf("UpdateRoutingMode: %v", err)
	}
	t.Cleanup(func() { _ = config.UpdateRoutingMode(config.RoutingModeWeighted) })
	p := pool.GetPool()
	p.Reload()
	return &Handler{pool: p, affinity: newSessionAffinity()}
}

// In priority mode a conversation bound to a lower-priority account goes back
// to the top account once it is free, logs the move, and is bound there after
// the turn succeeds.
func TestPickAccountPriorityModeMovesConversationToHigherPriority(t *testing.T) {
	h := priorityAffinityHandler(t)
	logs := captureLogs(t)
	conv := payloadFor("conversation-prio")
	h.affinity.Bind(affinityKey(conv), "prio-low")

	acc := h.pickAccount(context.Background(), conv, "", nil)
	if acc == nil || acc.ID != "prio-top" {
		t.Fatalf("bound turn went to %v, want prio-top", acc)
	}
	want := "[SessionAffinity] Conversation moved from bound account prio-low@example.com (priority 3) to higher-priority account prio-top@example.com (priority 0)"
	if !strings.Contains(logs.String(), want) {
		t.Fatalf("missing %q in logs:\n%s", want, logs)
	}
	if strings.Contains(logs.String(), "unavailable") {
		t.Fatalf("a move by priority was logged as an unavailable account:\n%s", logs)
	}
	h.rememberAccount(context.Background(), conv, acc)
	if got := h.affinity.Lookup(affinityKey(conv)); got != "prio-top" {
		t.Fatalf("binding after the move = %q, want prio-top", got)
	}
}

// The move only happens toward an account this request may use: a key bound to
// the lower account keeps the conversation there, and weighted mode never moves it.
func TestPickAccountPriorityModeKeepsConversationWhenTopNotUsable(t *testing.T) {
	h := priorityAffinityHandler(t)
	conv := payloadFor("conversation-prio")
	h.affinity.Bind(affinityKey(conv), "prio-low")

	key := config.ApiKeyEntry{ID: "k-low", Key: "sk-low", AccountIDs: []string{"prio-low"}}
	ctx := withApiKeyContext(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), &key).Context()
	if acc := h.pickAccount(ctx, conv, "", nil); acc == nil || acc.ID != "prio-low" {
		t.Fatalf("key limited to prio-low: got %v, want prio-low", acc)
	}
	if acc := h.pickAccount(context.Background(), conv, "", map[string]bool{"prio-top": true}); acc == nil || acc.ID != "prio-low" {
		t.Fatalf("prio-top excluded: got %v, want prio-low", acc)
	}

	if err := config.UpdateRoutingMode(config.RoutingModeWeighted); err != nil {
		t.Fatal(err)
	}
	if acc := h.pickAccount(context.Background(), conv, "", nil); acc == nil || acc.ID != "prio-low" {
		t.Fatalf("weighted mode: got %v, want prio-low", acc)
	}
}
