package proxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"kiro-proxy/db"
)

// seedTiedRequests writes n rows whose sort columns repeat a lot, so every sort leans on
// its id tie-break, and whose timestamps repeat too.
func seedTiedRequests(t *testing.T, n int) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	tx, err := d.Begin()
	if err != nil {
		t.Fatal(err)
	}
	emails := []string{"B@example.com", "a@example.com", "", "c@Example.com"}
	keys := []string{"", "sk-AAA****1111", "sk-bbb****2222"}
	for i := 0; i < n; i++ {
		success := i%4 != 1
		errType := ""
		if !success {
			errType = []string{"rate_limit", "upstream"}[i%2]
		}
		if _, err := tx.Exec(`INSERT INTO requests
(ts, account_id, api_key_id, api_key, email, model, total_tokens, credits, success, status, message, duration_ms, error_type, request_id, conversation_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			1_700_000_000+int64(i/3), fmt.Sprintf("acc-%d", i%5), fmt.Sprintf("key-%d", i%3), keys[i%3], emails[i%4],
			[]string{"m-b", "M-a", "m-c"}[i%3], (i%7)*100, float64(i%6)/4, success, 200, fmt.Sprintf("msg %d", i%11), (i%9)*10, errType,
			fmt.Sprintf("req-%d", i), fmt.Sprintf("conv-%d", i%13)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

// legacyRequestPageIDs is the page query from before the id-first form: one statement that
// sorts whole rows. Its ids and count are what every page must still return.
func legacyRequestPageIDs(t *testing.T, q requestQuery) ([]int64, int) {
	t.Helper()
	q = normalizeRequestQuery(q)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	var where []string
	var args []interface{}
	switch q.Status {
	case "success":
		where = append(where, "success = 1")
	case "failed":
		where = append(where, "success = 0")
	}
	if q.ErrorType != "" {
		where = append(where, "success = 0 AND error_type = ?")
		args = append(args, q.ErrorType)
	}
	if q.Conversation != "" {
		where = append(where, "conversation_id = ?")
		args = append(args, q.Conversation)
	}
	if q.APIKeyID != "" {
		where = append(where, "api_key_id = ?")
		args = append(args, q.APIKeyID)
	}
	if q.Search != "" {
		like := "%" + escapeSQLLike(q.Search) + "%"
		keyClause, keyArgs := newRequestKeySearch(q.Search).sql()
		where = append(where, "(email LIKE ? ESCAPE '\\' OR account_id LIKE ? ESCAPE '\\' OR api_key_id LIKE ? ESCAPE '\\' OR api_key LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR endpoint LIKE ? ESCAPE '\\' OR error_type LIKE ? ESCAPE '\\' OR request_id LIKE ? ESCAPE '\\'"+keyClause+")")
		args = append(args, like, like, like, like, like, like, like, like, like)
		args = append(args, keyArgs...)
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := d.QueryRow("SELECT COUNT(*) FROM requests"+whereSQL, args...).Scan(&total); err != nil {
		t.Fatal(err)
	}
	order := "DESC"
	if q.Order == "asc" {
		order = "ASC"
	}
	rows, err := d.Query(`SELECT id FROM requests`+whereSQL+` ORDER BY `+requestSortColumns[q.Sort]+` `+order+`, id `+order+` LIMIT ? OFFSET ?`,
		append(args, q.PageSize, (q.Page-1)*q.PageSize)...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids, total
}

func TestRequestPageMatchesWholeRowSort(t *testing.T) {
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(tempDataDir(t)); err != nil {
		t.Fatal(err)
	}
	const rows = 120
	seedTiedRequests(t, rows)

	filters := []requestQuery{
		{},
		{Status: "success"},
		{Status: "failed"},
		{ErrorType: "upstream"},
		{Conversation: "conv-4"},
		{APIKeyID: "key-2"},
		{Search: "example"},
		{Search: "msg 3", Status: "failed"},
		{Search: "nothing matches this"},
	}
	for _, f := range filters {
		for sort := range requestSortColumns {
			for _, order := range []string{"asc", "desc"} {
				// Page size, page: the first pages, the last full one, the short one and one past the end.
				for _, pg := range [][2]int{{7, 1}, {7, 2}, {7, 3}, {7, 17}, {7, 18}, {7, 19}, {50, 1}, {50, 2}, {50, 3}, {50, 4}} {
					pageSize, page := pg[0], pg[1]
					q := f
					q.Sort, q.Order, q.Page, q.PageSize = sort, order, page, pageSize
					got, err := queryPersistedRequests(q)
					if err != nil {
						t.Fatal(err)
					}
					wantIDs, wantTotal := legacyRequestPageIDs(t, q)
					gotIDs := make([]int64, 0, len(got.Requests))
					for _, rec := range got.Requests {
						gotIDs = append(gotIDs, rec.ID)
					}
					if got.Total != wantTotal || fmt.Sprint(gotIDs) != fmt.Sprint(wantIDs) {
						t.Fatalf("%+v: total %d ids %v, want total %d ids %v", q, got.Total, gotIDs, wantTotal, wantIDs)
					}
				}
			}
		}
	}
}

func TestRequestPageStopsWhenTheClientLeaves(t *testing.T) {
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(tempDataDir(t)); err != nil {
		t.Fatal(err)
	}
	seedTiedRequests(t, 10)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := queryPersistedRequestsContext(ctx, requestQuery{Search: "example"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	// The connection is free again for the next page.
	if page, err := queryPersistedRequests(requestQuery{}); err != nil || page.Total != 10 {
		t.Fatalf("page after cancel: total %d err %v", page.Total, err)
	}
}

// TestRequestStatsCacheMatchesFullSum checks the cached all-time totals against a full sum
// after each kind of change: new rows, late credits, a prune and a reset.
func TestRequestStatsCacheMatchesFullSum(t *testing.T) {
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(tempDataDir(t)); err != nil {
		t.Fatal(err)
	}
	fullSum := func() persistedRequestStats {
		t.Helper()
		requestLogChanged()
		stats, err := queryPersistedRequestStats()
		if err != nil {
			t.Fatal(err)
		}
		return stats
	}
	check := func(step string) {
		t.Helper()
		cached, err := queryPersistedRequestStats()
		if err != nil {
			t.Fatal(err)
		}
		if want := fullSum(); cached != want {
			t.Fatalf("%s: cached %+v, full sum %+v", step, cached, want)
		}
	}
	logRow := func(ts int64, success bool, tokens int, credits float64) int64 {
		t.Helper()
		id, err := persistRequestRecord(requestRecord{TS: ts, AccountID: "acc", Model: "m", InTokens: tokens, OutTokens: 1, TotalTokens: tokens + 1, Credits: credits, Success: success})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}

	check("empty")
	first := logRow(100, true, 10, 0.5)
	logRow(100, false, 0, 0)
	if err := persistErrorRecord(errorRecord{TS: 100, AccountID: "acc", Model: "m"}); err != nil {
		t.Fatal(err)
	}
	check("first rows")
	logRow(200_000, true, 30, 1.25)
	if err := persistErrorRecord(errorRecord{TS: 200_000, AccountID: "acc", Model: "m"}); err != nil {
		t.Fatal(err)
	}
	check("rows since")
	if err := addPersistedRequestCredits(first, 0.25); err != nil {
		t.Fatal(err)
	}
	check("late credits")
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	if n, err := pruneRequestsBatch(d, 1000, 10); err != nil || n != 2 {
		t.Fatalf("prune: %d, %v", n, err)
	}
	if n, err := pruneErrorsBatch(d, 1000, 10); err != nil || n != 1 {
		t.Fatalf("prune errors: %d, %v", n, err)
	}
	check("pruned")
	logRow(200_001, true, 5, 0.5)
	check("after prune")
	if got := fullSum(); got.TotalRequests != 4 || got.SuccessRequests != 3 || got.TotalErrorEvents != 2 || got.TotalCredits != 2.5 {
		t.Fatalf("totals %+v", got)
	}
	if err := resetRequestLog(); err != nil {
		t.Fatal(err)
	}
	check("reset")
	if got, _ := queryPersistedRequestStats(); got != (persistedRequestStats{}) {
		t.Fatalf("after reset %+v", got)
	}
}
