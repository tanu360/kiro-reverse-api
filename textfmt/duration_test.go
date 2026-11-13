package textfmt

import (
	"testing"
	"time"
)

func TestDuration(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want string
	}{
		{-time.Second, "0s"},
		{0, "0s"},
		{300 * time.Millisecond, "300ms"},
		{999*time.Millisecond + 400*time.Microsecond, "999ms"},
		{999*time.Millisecond + 600*time.Microsecond, "1s"},
		{time.Second, "1s"},
		{1499 * time.Millisecond, "1s"},
		{1500 * time.Millisecond, "2s"},
		{10 * time.Second, "10s"},
		{45 * time.Second, "45s"},
		{59 * time.Second, "59s"},
		{59*time.Second + 600*time.Millisecond, "1m"},
		{60 * time.Second, "1m"},
		{90 * time.Second, "1m 30s"},
		{15 * time.Minute, "15m"},
		{30 * time.Minute, "30m"},
		{3600 * time.Second, "1h"},
		{3630 * time.Second, "1h"},
		{3660 * time.Second, "1h 1m"},
		{3661 * time.Second, "1h 1m"},
		{4500 * time.Second, "1h 15m"},
		{90 * time.Minute, "1h 30m"},
		{24 * time.Hour, "1d"},
		{24*time.Hour + 30*time.Minute, "1d"},
		{51 * time.Hour, "2d 3h"},
		{51*time.Hour + 59*time.Minute, "2d 3h"},
		{400 * 24 * time.Hour, "400d"},
	}
	for _, c := range cases {
		if got := Duration(c.in); got != c.want {
			t.Errorf("Duration(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
