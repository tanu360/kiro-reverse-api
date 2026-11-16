package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"kiro-proxy/db"
)

// userUsageAt is GET /user/api/usage for rng and tz, decoded, with a fresh cache.
func userUsageAt(t *testing.T, h *Handler, token, rng string, tz int) (userUsageResponse, string) {
	t.Helper()
	h.userUsage = userUsageCache{}
	rec := userCall(h, http.MethodGet, "/user/api/usage?range="+rng+"&tzOffset="+strconv.Itoa(tz), token, "")
	var usage userUsageResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &usage); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("usage %s tz %d: %d %s", rng, tz, rec.Code, rec.Body.String())
	}
	return usage, rec.Body.String()
}

func clearRequestLog(t *testing.T) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`DELETE FROM requests`); err != nil {
		t.Fatal(err)
	}
}

// The stretch before a window is as long as the part of the window that has passed and ends one
// window earlier: its first and last second count, the seconds either side do not, and only this
// key's rows (by ID, or by the raw value an old row kept) are in it. All time has none.
func TestUserUsagePreviousStretch(t *testing.T) {
	h := newUserAPITestHandler(t)
	mine := addUsageKey(t, "mine", "sk-user-previous-mine-0123456789", true)
	other := addUsageKey(t, "other", "sk-user-previous-other-0123456789", true)
	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	pinObserveClock(t, now)
	token := userSignIn(t, h, mine.Key)

	for _, c := range []struct {
		rng string
		tz  int
	}{{"24h", 0}, {"24h", 330}, {"7d", -840}, {"7d", 0}, {"30d", 840}, {"30d", 60}} {
		rng, _ := parseUsageRange(c.rng)
		off := int64(c.tz) * 60
		from := ((now.Unix()+off)/rng.bucketSec-int64(rng.buckets)+1)*rng.bucketSec - off
		span := rng.bucketSec * int64(rng.buckets)
		first, last := from-span, now.Unix()-span
		clearRequestLog(t)
		insertUsageRows(t,
			usageRow{ts: first, keyID: mine.ID, success: true, in: 10, out: 5, credits: 0.5},
			usageRow{ts: first + 1, key: mine.Key, success: true},
			usageRow{ts: last, keyID: mine.ID, success: false},
			usageRow{ts: first - 1, keyID: mine.ID, success: true},
			usageRow{ts: last + 1, keyID: mine.ID, success: true},
			usageRow{ts: first, keyID: other.ID, success: true, repeated: 4},
			usageRow{ts: now.Unix() - 60, keyID: mine.ID, success: true},
		)
		usage, _ := userUsageAt(t, h, token, c.rng, c.tz)
		want := apiKeyUsageTotals{Requests: 3, Succeeded: 2, Failed: 1, InTokens: 10, OutTokens: 5, Tokens: 15, Credits: 0.5}
		if usage.Previous == nil || *usage.Previous != want {
			t.Fatalf("%s tz %d: previous %+v, want %+v", c.rng, c.tz, usage.Previous, want)
		}
		if usage.Totals.Requests != 1 {
			t.Fatalf("%s tz %d: totals %+v, want the one request of the window", c.rng, c.tz, usage.Totals)
		}
	}

	// A key with nothing before its window gets zeros, not nothing.
	clearRequestLog(t)
	usage, _ := userUsageAt(t, h, token, "7d", 0)
	if usage.Previous == nil || *usage.Previous != (apiKeyUsageTotals{}) {
		t.Fatalf("idle previous %+v", usage.Previous)
	}

	_, body := userUsageAt(t, h, token, "all", 0)
	if strings.Contains(body, `"previous"`) {
		t.Fatalf("all time has a previous stretch: %s", body)
	}
}

// Rows log retention pruned count from their daily totals: a day the stretch covers whole counts
// whole, a day it covers in part counts that part, and a pruned day's rows lie before the oldest
// row the log still has.
func TestUserUsagePreviousCountsPrunedDays(t *testing.T) {
	h := newUserAPITestHandler(t)
	mine := addUsageKey(t, "mine", "sk-user-pruned-mine-0123456789", true)
	other := addUsageKey(t, "other", "sk-user-pruned-other-0123456789", true)
	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	pinObserveClock(t, now)
	token := userSignIn(t, h, mine.Key)
	today := now.Unix() / daySeconds

	// 24h: the stretch is 15:00 two days ago to 14:25 yesterday. Two days ago it covers 9 of 24
	// hours: 9 of 24 requests. Yesterday the log keeps everything from 12:00, so its 48 pruned
	// requests lie before 12:00, inside the stretch. Three days ago is outside it.
	insertDailyRollup(t, today-2, mine.ID, "m", "acc", 24)
	insertDailyRollup(t, today-1, mine.ID, "m", "acc", 48)
	insertDailyRollup(t, today-1, other.ID, "m", "acc", 7)
	insertDailyRollup(t, today-3, mine.ID, "m", "acc", 100)
	insertUsageRows(t, usageRow{ts: (today-1)*daySeconds + 12*3600, keyID: mine.ID, success: true})
	usage, _ := userUsageAt(t, h, token, "24h", 0)
	if usage.Previous == nil || usage.Previous.Requests != 9+48+1 || usage.Previous.Failed != 0 {
		t.Fatalf("24h previous %+v, want 58 requests", usage.Previous)
	}

	// 7d: the stretch is 13 days ago to 14:25 seven days ago. Ten days ago counts whole; seven
	// days ago 14h 25m of 24h: 14 of 24 requests. A log that reaches back past the stretch
	// starts after every pruned row, so its days' totals are not read again.
	clearRequestLog(t)
	insertDailyRollup(t, today-10, mine.ID, "m", "acc", 5)
	insertDailyRollup(t, today-7, mine.ID, "m", "acc", 24)
	insertDailyRollup(t, today-14, mine.ID, "m", "acc", 100)
	insertUsageRows(t, usageRow{ts: now.Unix() - 60, keyID: mine.ID, success: true})
	usage, _ = userUsageAt(t, h, token, "7d", 0)
	if usage.Previous == nil || usage.Previous.Requests != 5+14 {
		t.Fatalf("7d previous %+v, want 19 requests", usage.Previous)
	}
	insertUsageRows(t, usageRow{ts: (today - 20) * daySeconds, keyID: other.ID, success: true})
	usage, _ = userUsageAt(t, h, token, "7d", 0)
	if usage.Previous == nil || usage.Previous.Requests != 0 {
		t.Fatalf("7d previous with the log reaching back %+v, want none", usage.Previous)
	}
}

func TestScaleUsageTotals(t *testing.T) {
	t.Parallel()
	in := apiKeyUsageTotals{Requests: 3, Succeeded: 1, Failed: 2, InTokens: 5, OutTokens: 2, Tokens: 7, Credits: 1}
	for _, c := range []struct {
		share float64
		want  apiKeyUsageTotals
	}{
		{1, in},
		{1.5, in},
		{0.5, apiKeyUsageTotals{Requests: 2, Succeeded: 1, InTokens: 3, OutTokens: 1, Credits: 0.5}},
		{0, apiKeyUsageTotals{}},
	} {
		if got := scaleUsageTotals(in, c.share); got != c.want {
			t.Fatalf("share %v: %+v, want %+v", c.share, got, c.want)
		}
	}
}
