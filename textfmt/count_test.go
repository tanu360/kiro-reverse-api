package textfmt

import "testing"

func TestCount(t *testing.T) {
	cases := []struct {
		n    int
		want string
	}{
		{0, "0 requests"},
		{1, "1 request"},
		{2, "2 requests"},
		{-1, "-1 requests"},
	}
	for _, c := range cases {
		if got := Count(c.n, "request", "requests"); got != c.want {
			t.Fatalf("Count(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}
