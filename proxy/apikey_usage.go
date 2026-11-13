package proxy

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// Codes for GET /admin/api/api-keys/usage. The UI only sends valid values, so they stay out of
// the shared list in admin_errors.go.
const (
	codeInvalidUsageRange = "invalid_usage_range"
	codeInvalidTZOffset   = "invalid_tz_offset"
)

// maxTZOffsetMin bounds tzOffset: UTC-14:00 to UTC+14:00 covers every real zone.
const maxTZOffsetMin = 14 * 60

// Kinds of traffic in the usage response. A configured key is "key"; a request logged under a
// key ID that config no longer has is "deleted"; a rejected request whose key matches no
// configured key is "invalid"; a request without any key (the requirement off) is "none".
const (
	usageKindKey     = "key"
	usageKindDeleted = "deleted"
	usageKindInvalid = "invalid"
	usageKindNone    = "none"
)

// usageRange is one selectable window: buckets × bucketSec seconds ending with the current,
// partial bucket.
type usageRange struct {
	name      string
	bucket    string
	bucketSec int64
	buckets   int
}

var usageRanges = map[string]usageRange{
	"24h": {name: "24h", bucket: "hour", bucketSec: 3600, buckets: 24},
	"7d":  {name: "7d", bucket: "day", bucketSec: 86400, buckets: 7},
	"30d": {name: "30d", bucket: "day", bucketSec: 86400, buckets: 30},
}

// parseUsageRange reads ?range=; empty is 24h.
func parseUsageRange(s string) (usageRange, bool) {
	if s == "" {
		s = "24h"
	}
	rng, ok := usageRanges[s]
	return rng, ok
}

// parseTZOffset reads ?tzOffset= as minutes east of UTC (the browser's -getTimezoneOffset());
// empty is UTC.
func parseTZOffset(s string) (int, bool) {
	if s == "" {
		return 0, true
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < -maxTZOffsetMin || n > maxTZOffsetMin {
		return 0, false
	}
	return n, true
}

type apiKeyUsageTotals struct {
	Requests  int64   `json:"requests"`
	Succeeded int64   `json:"succeeded"`
	Failed    int64   `json:"failed"`
	InTokens  int64   `json:"inTokens"`
	OutTokens int64   `json:"outTokens"`
	Tokens    int64   `json:"tokens"`
	Credits   float64 `json:"credits"`
}

func (t *apiKeyUsageTotals) add(o apiKeyUsageTotals) {
	t.Requests += o.Requests
	t.Succeeded += o.Succeeded
	t.Failed += o.Failed
	t.InTokens += o.InTokens
	t.OutTokens += o.OutTokens
	t.Tokens += o.Tokens
	t.Credits += o.Credits
}

// apiKeyUsageEntry is one row of the comparison: a configured key, a deleted key, all invalid
// keys together, or the traffic without a key. KeyMasked never carries more than
// config.MaskApiKey shows.
type apiKeyUsageEntry struct {
	ID        string              `json:"id"`
	Kind      string              `json:"kind"`
	Name      string              `json:"name,omitempty"`
	KeyMasked string              `json:"keyMasked,omitempty"`
	Totals    apiKeyUsageTotals   `json:"totals"`
	Series    []apiKeyUsageTotals `json:"series"`
}

type apiKeyUsageResponse struct {
	Range         string             `json:"range"`
	Bucket        string             `json:"bucket"`
	BucketSeconds int64              `json:"bucketSeconds"`
	TZOffset      int                `json:"tzOffset"`
	From          int64              `json:"from"`
	To            int64              `json:"to"`
	NowUnix       int64              `json:"nowUnix"`
	Buckets       []int64            `json:"buckets"`
	Totals        apiKeyUsageTotals  `json:"totals"`
	Keys          []apiKeyUsageEntry `json:"keys"`
}

// Slots the SQL CASE gives a row; 0..n-1 is the configured key a rejected request named.
const (
	usageSlotByID    = -1
	usageSlotNoKey   = -2
	usageSlotUnknown = -3
)

// rejectedKeyID is the ID of the configured key a refused request sent (one
// that is disabled or over a limit), so the request stays with that key when
// it is regenerated later. A value that names no key gives "".
func rejectedKeyID(provided string) string {
	if provided == "" {
		return ""
	}
	if entry := config.FindApiKeyByValue(provided); entry != nil {
		return entry.ID
	}
	return ""
}

// queryApiKeyUsage buckets the request log of [from, to) by key. Buckets start at the viewer's
// local hour or midnight (tzOffsetMin), the last one is the current, partial bucket, and every
// series is dense: one value per bucket, zero where nothing happened. Raw key values are only
// compared inside SQLite; the response carries IDs, names and masked keys.
func queryApiKeyUsage(now time.Time, rng usageRange, tzOffsetMin int, keys []config.ApiKeyEntry) (apiKeyUsageResponse, error) {
	size := rng.bucketSec
	n := int64(rng.buckets)
	off := int64(tzOffsetMin) * 60
	cur := (now.Unix() + off) / size
	first := cur - n + 1
	from := first*size - off
	to := (cur+1)*size - off

	resp := apiKeyUsageResponse{
		Range:         rng.name,
		Bucket:        rng.bucket,
		BucketSeconds: size,
		TZOffset:      tzOffsetMin,
		From:          from,
		To:            to,
		NowUnix:       now.Unix(),
		Buckets:       make([]int64, n),
		Keys:          []apiKeyUsageEntry{},
	}
	for i := range resp.Buckets {
		resp.Buckets[i] = from + int64(i)*size
	}

	d, err := db.Get()
	if err != nil {
		return resp, err
	}

	// Versions before 3.3.0 logged a rejected request with an empty key ID and the raw key it
	// sent. The start-up migration (db.MaskRequestKeys) gives such a row its key's ID and masks
	// the value; the CASE still names the key's slot for a row it could not reach.
	var slotCases strings.Builder
	args := []interface{}{off, size}
	for i, key := range keys {
		if key.Key == "" {
			continue
		}
		slotCases.WriteString(" WHEN api_key = ? THEN " + strconv.Itoa(i))
		args = append(args, key.Key)
	}
	args = append(args, from, to)

	rows, err := d.Query(`SELECT
(ts + ?) / ? AS b,
api_key_id,
CASE
 WHEN api_key_id <> '' THEN `+strconv.Itoa(usageSlotByID)+`
 WHEN api_key = '' THEN `+strconv.Itoa(usageSlotNoKey)+slotCases.String()+`
 ELSE `+strconv.Itoa(usageSlotUnknown)+`
END AS slot,
COUNT(*),
COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(in_tokens), 0),
COALESCE(SUM(out_tokens), 0),
COALESCE(SUM(credits), 0)
FROM requests
WHERE ts >= ? AND ts < ?
GROUP BY b, api_key_id, slot`, args...)
	if err != nil {
		return resp, err
	}
	defer rows.Close()

	byID := make(map[string]int, len(keys))
	for i, key := range keys {
		byID[key.ID] = i
	}
	entries := make(map[string]*apiKeyUsageEntry)
	entryFor := func(id, kind string) *apiKeyUsageEntry {
		ref := kind + ":" + id
		if e, ok := entries[ref]; ok {
			return e
		}
		e := &apiKeyUsageEntry{ID: id, Kind: kind, Series: make([]apiKeyUsageTotals, n)}
		entries[ref] = e
		return e
	}

	for rows.Next() {
		var (
			bucket int64
			keyID  string
			slot   int
			t      apiKeyUsageTotals
		)
		if err := rows.Scan(&bucket, &keyID, &slot, &t.Requests, &t.Succeeded, &t.InTokens, &t.OutTokens, &t.Credits); err != nil {
			return resp, err
		}
		idx := bucket - first
		if idx < 0 || idx >= n {
			continue
		}
		t.Failed = t.Requests - t.Succeeded
		t.Tokens = t.InTokens + t.OutTokens

		var e *apiKeyUsageEntry
		switch {
		case slot == usageSlotByID:
			if i, ok := byID[keyID]; ok {
				e = entryFor(keys[i].ID, usageKindKey)
			} else {
				e = entryFor(keyID, usageKindDeleted)
			}
		case slot >= 0 && slot < len(keys):
			e = entryFor(keys[slot].ID, usageKindKey)
		case slot == usageSlotNoKey:
			e = entryFor(usageKindNone, usageKindNone)
		default:
			e = entryFor(usageKindInvalid, usageKindInvalid)
		}
		e.Series[idx].add(t)
		e.Totals.add(t)
		resp.Totals.add(t)
	}
	if err := rows.Err(); err != nil {
		return resp, err
	}

	for _, e := range entries {
		switch e.Kind {
		case usageKindKey:
			key := keys[byID[e.ID]]
			e.Name = key.Name
			e.KeyMasked = config.MaskApiKey(key.Key)
		case usageKindDeleted:
			//! The value it last sent: a key regenerated before it was deleted sent several.
			var last string
			if err := d.QueryRow(`SELECT api_key FROM requests WHERE api_key_id = ? AND api_key <> '' AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1`, e.ID, from, to).Scan(&last); err == nil {
				e.KeyMasked = config.MaskApiKey(last)
			}
		}
		resp.Keys = append(resp.Keys, *e)
	}
	sort.Slice(resp.Keys, func(i, j int) bool {
		a, b := resp.Keys[i], resp.Keys[j]
		if a.Totals.Requests != b.Totals.Requests {
			return a.Totals.Requests > b.Totals.Requests
		}
		if a.Totals.Credits != b.Totals.Credits {
			return a.Totals.Credits > b.Totals.Credits
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.ID < b.ID
	})
	return resp, nil
}

// apiApiKeyUsage serves GET /admin/api/api-keys/usage?range=24h|7d|30d&tzOffset=<minutes>.
func (h *Handler) apiApiKeyUsage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rng, ok := parseUsageRange(q.Get("range"))
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeInvalidUsageRange, "range must be 24h, 7d or 30d")
		return
	}
	tz, ok := parseTZOffset(q.Get("tzOffset"))
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeInvalidTZOffset, "tzOffset must be whole minutes between -840 and 840")
		return
	}
	resp, err := queryApiKeyUsage(observeNow(), rng, tz, config.ListApiKeys())
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}
	json.NewEncoder(w).Encode(resp)
}
