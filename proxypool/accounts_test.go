package proxypool

import "testing"

func TestForgetAccountsFreesTheirProxySlot(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"), poolProxy("px_b", "http://10.0.0.2:3128"))
	keep, gone := addAccount(t, "keep", ""), addAccount(t, "gone", "")
	if r := m.Resolve(keep); r.ProxyID != "px_a" {
		t.Fatalf("keep got %s, want px_a", r.ProxyID)
	}
	if r := m.Resolve(gone); r.ProxyID != "px_b" {
		t.Fatalf("gone got %s, want px_b", r.ProxyID)
	}

	m.ForgetAccounts("gone", "never-assigned")
	if _, ok := m.Assignment("gone"); ok {
		t.Fatal("the removed account kept its assignment")
	}
	if id, ok := m.Assignment("keep"); !ok || id != "px_a" {
		t.Fatalf("keep assignment = %q %v, want px_a", id, ok)
	}
	// px_b carries no account now, so it is the least loaded for the next new account.
	if r := m.Resolve(addAccount(t, "next", "")); r.ProxyID != "px_b" {
		t.Fatalf("next account got %s, want px_b", r.ProxyID)
	}
}
