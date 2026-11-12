package pool

import (
	"testing"
	"time"

	"kiro-proxy/config"
)

func TestGetPreferredForModelAllowedPicksOnlyAllowed(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"}, config.Account{ID: "d"})
	allowed := AllowedSet([]string{"b", "d"})
	excluded := map[string]bool{}

	seen := map[string]int{}
	for i := 0; i < 8; i++ {
		acc := p.GetPreferredForModelAllowed("", "", excluded, allowed)
		if acc == nil {
			t.Fatalf("pick %d: nil", i)
		}
		seen[acc.ID]++
	}
	if seen["a"] != 0 || seen["c"] != 0 {
		t.Fatalf("picked accounts outside the allowlist: %v", seen)
	}
	// Rotation still spreads the key's requests over its accounts.
	if seen["b"] != 4 || seen["d"] != 4 {
		t.Fatalf("picks = %v, want b and d 4 times each", seen)
	}
	if len(excluded) != 0 {
		t.Fatalf("the caller's exclusions were written: %v", excluded)
	}

	// A cooled-down bound account leaves only the other one, never an unbound one.
	p.cooldowns["b"] = time.Now().Add(time.Minute)
	for i := 0; i < 3; i++ {
		if acc := p.GetPreferredForModelAllowed("", "", nil, allowed); acc == nil || acc.ID != "d" {
			t.Fatalf("with b cooling down got %v, want d", acc)
		}
	}
	// The web search picker follows the same list.
	if acc := p.GetNextForModelAllowed("", map[string]bool{"d": true}, allowed); acc != nil {
		t.Fatalf("GetNextForModelAllowed = %s, want nil (b cooling, d excluded)", acc.ID)
	}
}

func TestGetPreferredForModelAllowedNilAllowsAll(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})
	if AllowedSet(nil) != nil || AllowedSet([]string{}) != nil {
		t.Fatal("an empty allowlist is not nil")
	}
	first := p.GetPreferredForModelAllowed("", "", nil, nil)
	second := p.GetPreferredForModelAllowed("", "", nil, nil)
	if first.ID != "a" || second.ID != "b" {
		t.Fatalf("got %s then %s, want plain rotation a then b", first.ID, second.ID)
	}
	if acc := p.GetPreferredForModelAllowed("b", "", nil, nil); acc == nil || acc.ID != "b" {
		t.Fatalf("preferred = %v, want b", acc)
	}
	if acc := p.GetNextForModelAllowed("", map[string]bool{"a": true}, nil); acc == nil || acc.ID != "b" {
		t.Fatalf("GetNextForModelAllowed = %v, want b", acc)
	}
}

// Session affinity may point at an account the key may not use: it is ignored.
func TestGetPreferredForModelAllowedDropsDisallowedPreferred(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"})
	allowed := AllowedSet([]string{"c"})
	for i := 0; i < 3; i++ {
		if acc := p.GetPreferredForModelAllowed("a", "", nil, allowed); acc == nil || acc.ID != "c" {
			t.Fatalf("got %v, want c", acc)
		}
	}
	// An allowed preference still wins over rotation.
	allowed = AllowedSet([]string{"a", "c"})
	for i := 0; i < 3; i++ {
		if acc := p.GetPreferredForModelAllowed("c", "", nil, allowed); acc == nil || acc.ID != "c" {
			t.Fatalf("allowed preference: got %v, want c", acc)
		}
	}
}

func TestGetPreferredForModelAllowedNoneAvailable(t *testing.T) {
	cases := []struct {
		name    string
		allowed []string
		setup   func(p *AccountPool)
		model   string
	}{
		{name: "only deleted accounts", allowed: []string{"gone"}},
		{
			name:    "bound account cooling down",
			allowed: []string{"b"},
			setup:   func(p *AccountPool) { p.cooldowns["b"] = time.Now().Add(time.Minute) },
		},
		{
			name:    "bound account lacks the model",
			allowed: []string{"b"},
			setup:   func(p *AccountPool) { p.SetModelList("b", []string{"claude-haiku-4.5"}) },
			model:   "claude-opus-4.5",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})
			if tc.setup != nil {
				tc.setup(p)
			}
			allowed := AllowedSet(tc.allowed)
			if acc := p.GetPreferredForModelAllowed("", tc.model, nil, allowed); acc != nil {
				t.Fatalf("got %s, want nil: the key must not spill over to other accounts", acc.ID)
			}
			if acc := p.GetNextForModelAllowed(tc.model, nil, allowed); acc != nil {
				t.Fatalf("GetNextForModelAllowed got %s, want nil", acc.ID)
			}
		})
	}
}

func TestAllowedOffersModel(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"})
	p.enabledIDs = []string{"a", "b", "c", "over-limit"}
	p.SetModelList("a", []string{"claude-haiku-4.5", "claude-opus-4.5"})
	p.SetModelList("b", []string{"claude-haiku-4.5"})
	p.SetModelList("over-limit", []string{"glm-5"})

	bound := AllowedSet([]string{"b"})
	if !p.AllowedOffersModel(bound, "claude-haiku-4.5") {
		t.Fatal("b lists claude-haiku-4.5")
	}
	if p.AllowedOffersModel(bound, "claude-opus-4.5") {
		t.Fatal("only a, outside the list, offers claude-opus-4.5")
	}
	// An account with no model list yet may serve anything, as in OffersModel.
	if !p.AllowedOffersModel(AllowedSet([]string{"c"}), "claude-opus-4.5") {
		t.Fatal("c has no model list and should offer every model")
	}
	// Out of rotation but enabled (over its usage limit) still offers its models.
	if !p.AllowedOffersModel(AllowedSet([]string{"over-limit"}), "glm-5") {
		t.Fatal("an enabled over-limit account offers its models")
	}
	if p.AllowedOffersModel(AllowedSet([]string{"gone"}), "claude-haiku-4.5") {
		t.Fatal("an allowlist of deleted accounts offers nothing")
	}
	if !p.AllowedOffersModel(nil, "claude-opus-4.5") {
		t.Fatal("nil allowlist asks the whole pool")
	}
}
