package proxy

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// codeInvalidUsageRef answers a breakdown request whose ref names no entry kind.
const codeInvalidUsageRef = "invalid_usage_ref"

// usageBreakdownItem is one model's or one account's share of an entry's usage.
type usageBreakdownItem struct {
	ID string `json:"id"`
	// Label is an account's email; empty for a model (its ID is its name) and for an account
	// that no longer exists.
	Label     string  `json:"label,omitempty"`
	Requests  int64   `json:"requests"`
	Succeeded int64   `json:"succeeded"`
	Failed    int64   `json:"failed"`
	Tokens    int64   `json:"tokens"`
	Credits   float64 `json:"credits"`
}

type apiKeyUsageBreakdown struct {
	Ref      string               `json:"ref"`
	Range    string               `json:"range"`
	From     int64                `json:"from"`
	To       int64                `json:"to"`
	Models   []usageBreakdownItem `json:"models"`
	Accounts []usageBreakdownItem `json:"accounts"`
}

// breakdownSums adds usage rows to the model and account totals of one entry.
type breakdownSums struct {
	models   map[string]*usageBreakdownItem
	accounts map[string]*usageBreakdownItem
}

func (b *breakdownSums) add(model, accountID string, t apiKeyUsageTotals) {
	if t.Requests <= 0 {
		return
	}
	for _, target := range []struct {
		m  map[string]*usageBreakdownItem
		id string
	}{{b.models, model}, {b.accounts, accountID}} {
		item := target.m[target.id]
		if item == nil {
			item = &usageBreakdownItem{ID: target.id}
			target.m[target.id] = item
		}
		item.Requests += t.Requests
		item.Succeeded += t.Succeeded
		item.Failed += t.Requests - t.Succeeded
		item.Tokens += t.InTokens + t.OutTokens
		item.Credits += t.Credits
	}
}

// sorted lists the items busiest first; ties by credits, then by ID, so a refetch keeps the order.
func sortedBreakdown(m map[string]*usageBreakdownItem) []usageBreakdownItem {
	out := make([]usageBreakdownItem, 0, len(m))
	for _, item := range m {
		out = append(out, *item)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Requests != b.Requests {
			return a.Requests > b.Requests
		}
		if a.Credits != b.Credits {
			return a.Credits > b.Credits
		}
		return a.ID < b.ID
	})
	return out
}

// usageEntryRef is how the admin UI names a usage row (key-usage-model entryRef): "key:<id>" or
// "deleted:<id>" for a key, and just "none" or "invalid" for the two groups.
func usageEntryRef(e *apiKeyUsageEntry) string {
	if e.Kind == usageKindKey || e.Kind == usageKindDeleted {
		return e.Kind + ":" + e.ID
	}
	return e.Kind
}

// queryApiKeyUsageBreakdown splits one usage entry (ref as usageEntryRef names it) by model and by account over the same window as queryApiKeyUsage: the request log, plus
// the rows log retention pruned (by their day for 7d and 30d; every pruned row for all).
func queryApiKeyUsageBreakdown(now time.Time, rng usageRange, tzOffsetMin int, keys []config.ApiKeyEntry, ref string) (apiKeyUsageBreakdown, error) {
	resp := apiKeyUsageBreakdown{Ref: ref, Range: rng.name, Models: []usageBreakdownItem{}, Accounts: []usageBreakdownItem{}}
	off := int64(tzOffsetMin) * 60
	var firstDay, lastDay int64
	daily := false
	if rng.name == usageRangeAll {
		resp.From, resp.To = 0, now.Unix()+1
	} else {
		size := rng.bucketSec
		cur := (now.Unix() + off) / size
		first := cur - int64(rng.buckets) + 1
		resp.From, resp.To = first*size-off, (cur+1)*size-off
		if size == daySeconds {
			daily, firstDay, lastDay = true, first, cur
		}
	}

	d, err := db.Get()
	if err != nil {
		return resp, err
	}
	//! One transaction: a prune between the log and the rollup reads would count a row twice or
	//! miss it.
	tx, err := d.Begin()
	if err != nil {
		return resp, err
	}
	defer tx.Rollback()

	c := newUsageCollector(keys, 0)
	matches := func(keyID string, slot int) bool {
		return usageEntryRef(c.entry(keyID, slot)) == ref
	}
	sums := &breakdownSums{models: map[string]*usageBreakdownItem{}, accounts: map[string]*usageBreakdownItem{}}

	slot, slotArgs := usageSlotSQL(keys)
	args := append([]interface{}{}, slotArgs...)
	args = append(args, resp.From, resp.To)
	rows, err := tx.Query(`SELECT model, account_id, api_key_id, `+slot+` AS slot,
COUNT(*),
COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(in_tokens), 0),
COALESCE(SUM(out_tokens), 0),
COALESCE(SUM(credits), 0)
FROM requests
WHERE ts >= ? AND ts < ?
GROUP BY model, account_id, api_key_id, slot`, args...)
	if err != nil {
		return resp, err
	}
	for rows.Next() {
		var (
			model, accountID, keyID string
			slot                    int
			t                       apiKeyUsageTotals
		)
		if err := rows.Scan(&model, &accountID, &keyID, &slot, &t.Requests, &t.Succeeded, &t.InTokens, &t.OutTokens, &t.Credits); err != nil {
			rows.Close()
			return resp, err
		}
		if matches(keyID, slot) {
			sums.add(model, accountID, t)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return resp, err
	}

	if daily || rng.name == usageRangeAll {
		where := ""
		var dayArgs []interface{}
		if daily {
			where = "WHERE day >= ? AND day <= ?"
			dayArgs = append(dayArgs, firstDay, lastDay)
		}
		drows, err := tx.Query(`SELECT model, account_id, api_key_id, keyless,
COALESCE(SUM(request_count), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN request_count ELSE 0 END), 0),
COALESCE(SUM(in_tokens), 0),
COALESCE(SUM(out_tokens), 0),
COALESCE(SUM(credits), 0)
FROM request_rollup_daily `+where+`
GROUP BY model, account_id, api_key_id, keyless`, dayArgs...)
		if err != nil {
			return resp, err
		}
		for drows.Next() {
			var (
				model, accountID, keyID string
				keyless                 bool
				t                       apiKeyUsageTotals
			)
			if err := drows.Scan(&model, &accountID, &keyID, &keyless, &t.Requests, &t.Succeeded, &t.InTokens, &t.OutTokens, &t.Credits); err != nil {
				drows.Close()
				return resp, err
			}
			if matches(keyID, rollupUsageSlot(keyID, keyless)) {
				sums.add(model, accountID, t)
			}
		}
		drows.Close()
		if err := drows.Err(); err != nil {
			return resp, err
		}
	}

	if rng.name == usageRangeAll {
		//! The rows pruned before daily totals were kept: request_rollup beyond its daily rows. It
		//! kept no key value, so one without a key ID counts under no key, as the usage view does.
		urows, err := tx.Query(`SELECT r.model, r.account_id, r.api_key_id, r.success,
CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.request_count - COALESCE(d.n, 0) ELSE 0 END,
CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.in_tokens - COALESCE(d.i, 0) ELSE 0 END,
CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.out_tokens - COALESCE(d.o, 0) ELSE 0 END,
CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.credits - COALESCE(d.c, 0) ELSE 0 END
FROM request_rollup r LEFT JOIN (
SELECT model, account_id, api_key_id, success, SUM(request_count) AS n, SUM(in_tokens) AS i, SUM(out_tokens) AS o, SUM(credits) AS c
FROM request_rollup_daily GROUP BY model, account_id, api_key_id, success
) d ON d.model = r.model AND d.account_id = r.account_id AND d.api_key_id = r.api_key_id AND d.success = r.success`)
		if err != nil {
			return resp, err
		}
		for urows.Next() {
			var (
				model, accountID, keyID string
				success                 bool
				t                       apiKeyUsageTotals
			)
			if err := urows.Scan(&model, &accountID, &keyID, &success, &t.Requests, &t.InTokens, &t.OutTokens, &t.Credits); err != nil {
				urows.Close()
				return resp, err
			}
			if success {
				t.Succeeded = t.Requests
			}
			slot := usageSlotNoKey
			if keyID != "" {
				slot = usageSlotByID
			}
			if matches(keyID, slot) {
				sums.add(model, accountID, t)
			}
		}
		urows.Close()
		if err := urows.Err(); err != nil {
			return resp, err
		}
	}

	resp.Models = sortedBreakdown(sums.models)
	resp.Accounts = sortedBreakdown(sums.accounts)
	emails := make(map[string]string)
	for _, account := range config.GetAccounts() {
		emails[account.ID] = account.Email
	}
	for i := range resp.Accounts {
		resp.Accounts[i].Label = emails[resp.Accounts[i].ID]
	}
	return resp, nil
}

// validUsageRef reports whether ref names a usage row: "key:<id>", "deleted:<id>", "none" or "invalid".
func validUsageRef(ref string) bool {
	if ref == usageKindNone || ref == usageKindInvalid {
		return true
	}
	kind, id, ok := strings.Cut(ref, ":")
	return ok && id != "" && (kind == usageKindKey || kind == usageKindDeleted)
}

// apiApiKeyUsageBreakdown serves GET /admin/api/api-keys/usage/breakdown?ref=<kind:id>&range=24h|7d|30d|all&tzOffset=<minutes>.
func (h *Handler) apiApiKeyUsageBreakdown(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ref := q.Get("ref")
	if !validUsageRef(ref) {
		writeAdminError(w, http.StatusBadRequest, codeInvalidUsageRef, "ref must be key:<id>, deleted:<id>, none or invalid")
		return
	}
	rng, ok := parseUsageRange(q.Get("range"))
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeInvalidUsageRange, "range must be 24h, 7d, 30d or all")
		return
	}
	tz, ok := parseTZOffset(q.Get("tzOffset"))
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeInvalidTZOffset, "tzOffset must be whole minutes between -840 and 840")
		return
	}
	resp, err := queryApiKeyUsageBreakdown(observeNow(), rng, tz, config.ListApiKeys(), ref)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}
	json.NewEncoder(w).Encode(resp)
}
