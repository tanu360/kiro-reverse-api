package proxy

import (
	"strings"
	"testing"
	"time"
)

// The alert texts a person reads in a chat: counts agree with their noun and
// times are short, not RFC 3339.
func TestAlertTextsReadAsSentences(t *testing.T) {
	since := time.Date(2026, 11, 13, 10, 4, 59, 0, time.UTC).Unix()

	cases := []struct {
		name string
		got  string
		want string
	}{
		{"pool usage, one account", poolUsageMessage(90, 100, 1, 90, 0).Text,
			"The pool has used 90.0% of its credits (90 of 100, across 1 account)."},
		{"pool usage, three accounts", poolUsageMessage(240, 300, 3, 80, 0).Text,
			"The pool has used 80.0% of its credits (240 of 300, across 3 accounts)."},
		{"no account available, one account", allUnavailableMessage(1, since, 0).Text,
			"The only account in the pool has not been able to serve requests since 2026-11-13 10:04 UTC. It is banned, suspended, cooling down or out of credits."},
		{"no account available, three accounts", allUnavailableMessage(3, since, 0).Text,
			"None of the 3 accounts in the pool has been able to serve requests since 2026-11-13 10:04 UTC. Each one is banned, suspended, cooling down or out of credits."},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.name, c.got, c.want)
		}
		if strings.Contains(c.got, "T10:") {
			t.Errorf("%s: RFC 3339 time in %q", c.name, c.got)
		}
	}
}
