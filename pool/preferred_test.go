package pool

import (
	"kiro-proxy/config"
	"testing"
	"time"
)

func TestPreferredAccountIsReturnedWhenUsable(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"})

	for i := 0; i < 3; i++ {
		acc := p.GetPreferredForModelExcluding("b", "", nil)
		if acc == nil || acc.ID != "b" {
			t.Fatalf("pick %d: got %v, want b", i, acc)
		}
	}
}

// Sticky conversations must not steer where new conversations land: after any
// number of preferred hits, round-robin continues from where it was.
func TestPreferredHitLeavesRotationCursorAlone(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"})

	if acc := p.GetNext(); acc.ID != "a" {
		t.Fatalf("first rotation pick = %s, want a", acc.ID)
	}
	for i := 0; i < 5; i++ {
		p.GetPreferredForModelExcluding("c", "", nil)
	}
	if acc := p.GetNext(); acc.ID != "b" {
		t.Fatalf("rotation after preferred hits = %s, want b", acc.ID)
	}
}

// The binding is a preference, never a pin: an account that cannot serve right
// now must lose the conversation to rotation.
func TestPreferredAccountFallsBackWhenUnusable(t *testing.T) {
	cases := []struct {
		name     string
		setup    func(p *AccountPool)
		model    string
		excluded map[string]bool
	}{
		{
			name:  "cooling down",
			setup: func(p *AccountPool) { p.cooldowns["b"] = time.Now().Add(time.Minute) },
		},
		{
			name:     "excluded after failing this request",
			excluded: map[string]bool{"b": true},
		},
		{
			name:  "lacks the model",
			setup: func(p *AccountPool) { p.SetModelList("b", []string{"other-model"}) },
			model: "claude-sonnet-4.5",
		},
		{
			name: "no longer in the pool",
			setup: func(p *AccountPool) {
				p.accounts = []config.Account{{ID: "a"}, {ID: "c"}}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"})
			if tc.setup != nil {
				tc.setup(p)
			}
			acc := p.GetPreferredForModelExcluding("b", tc.model, tc.excluded)
			if acc == nil {
				t.Fatal("got nil, want a fallback account")
			}
			if acc.ID == "b" {
				t.Fatal("unusable preferred account was returned")
			}
		})
	}
}

func TestPreferredAccountSkipsExhaustedQuota(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "a"},
		config.Account{ID: "b", UsageCurrent: 10, UsageLimit: 10},
	)
	if acc := p.GetPreferredForModelExcluding("b", "", nil); acc == nil || acc.ID != "a" {
		t.Fatalf("got %v, want a", acc)
	}
}

func TestEmptyPreferenceIsPlainRotation(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})
	first := p.GetPreferredForModelExcluding("", "", nil)
	second := p.GetPreferredForModelExcluding("", "", nil)
	if first.ID != "a" || second.ID != "b" {
		t.Fatalf("got %s then %s, want a then b", first.ID, second.ID)
	}
}
