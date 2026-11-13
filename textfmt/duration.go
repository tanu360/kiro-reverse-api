// Package textfmt formats values for English text a person reads: alert
// messages, errors shown in the admin UI and log lines.
package textfmt

import (
	"strconv"
	"time"
)

var durationUnits = []struct {
	size   time.Duration
	suffix string
}{
	{24 * time.Hour, "d"},
	{time.Hour, "h"},
	{time.Minute, "m"},
	{time.Second, "s"},
}

// Duration writes d the way the admin UI does: the largest unit and the next
// one, a space between them, a zero second unit left out. 90s is "1m 30s", an
// hour is "1h", 75 minutes "1h 15m" and 51 hours "2d 3h", where
// time.Duration.String gives "1m30s", "1h0m0s", "1h15m0s" and "51h0m0s".
// Under a second it is whole milliseconds ("300ms"); zero or less is "0s".
// From a second up d is rounded to the second, and the smaller units past the
// two shown are dropped.
func Duration(d time.Duration) string {
	if d <= 0 {
		return "0s"
	}
	if ms := d.Round(time.Millisecond); ms < time.Second {
		return strconv.FormatInt(int64(ms/time.Millisecond), 10) + "ms"
	}
	rest := d.Round(time.Second)
	out := ""
	for _, unit := range durationUnits {
		n := rest / unit.size
		rest -= n * unit.size
		if out == "" {
			if n > 0 {
				out = strconv.FormatInt(int64(n), 10) + unit.suffix
			}
			continue
		}
		if n > 0 {
			out += " " + strconv.FormatInt(int64(n), 10) + unit.suffix
		}
		break
	}
	return out
}
