package proxy

import (
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"kiro-proxy/db"
)

// seedRequestLog bulk-writes n request rows the way a busy proxy logs them: a
// few accounts, keys and models, about one failure in ten, conversations of
// ten turns and an attempt chain on every row.
func seedRequestLog(tb testing.TB, n int) {
	tb.Helper()
	d, err := db.Get()
	if err != nil {
		tb.Fatal(err)
	}
	tx, err := d.Begin()
	if err != nil {
		tb.Fatal(err)
	}
	stmt, err := tx.Prepare(`INSERT INTO requests
(ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message, endpoint, duration_ms, error_type, attempts_json, request_id, conversation_id, client)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tb.Fatal(err)
	}
	models := []string{"claude-sonnet-4.5", "claude-opus-4.7", "claude-haiku-4.5", "auto", "claude-sonnet-4"}
	errTypes := []string{"rate_limit", "upstream", "timeout", "auth"}
	start := int64(1_700_000_000)
	for i := 0; i < n; i++ {
		acc := i % 37
		success := i%10 != 3
		status, message, errType := 200, "", ""
		if !success {
			status, errType = 429, errTypes[i%len(errTypes)]
			message = "upstream said too many requests for account " + strconv.Itoa(acc)
		}
		in, out := 1000+i%5000, 100+i%700
		attempts := fmt.Sprintf(`[{"accountId":"acc-%d","email":"user%d@example.com","endpoint":"claude","startMs":0,"durationMs":%d,"success":%t,"status":%d}]`, acc, acc, 200+i%3000, success, status)
		if _, err := stmt.Exec(start+int64(i)*7, fmt.Sprintf("acc-%d", acc), fmt.Sprintf("key-%d", i%5), "sk-abc****wxyz", fmt.Sprintf("user%d@example.com", acc),
			models[i%len(models)], in, out, in+out, float64(i%97)/10, success, status, message, "claude", 200+i%3000, errType, attempts,
			fmt.Sprintf("req-%08d", i), fmt.Sprintf("conv-%d", i/10), "claude-code"); err != nil {
			tb.Fatal(err)
		}
	}
	if err := stmt.Close(); err != nil {
		tb.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		tb.Fatal(err)
	}
}

// BenchmarkRequestLogPage times the Requests page queries over a seeded log.
// KIRO_BENCH_ROWS sets the log size (default 20000), e.g.
// KIRO_BENCH_ROWS=200000 go test ./proxy -run '^$' -bench RequestLogPage -benchtime 5x
func BenchmarkRequestLogPage(b *testing.B) {
	rows := 20000
	if v, err := strconv.Atoi(os.Getenv("KIRO_BENCH_ROWS")); err == nil && v > 0 {
		rows = v
	}
	if err := db.ResetForTest(b.TempDir()); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = db.Close() })
	seedRequestLog(b, rows)
	deep := rows / 100 / 2
	cases := []struct {
		name string
		q    requestQuery
	}{
		{"page1", requestQuery{PageSize: 100}},
		{"deep", requestQuery{PageSize: 100, Page: deep}},
		{"asc", requestQuery{PageSize: 100, Order: "asc"}},
		{"status", requestQuery{PageSize: 100, Sort: "status"}},
		{"account", requestQuery{PageSize: 100, Sort: "account"}},
		{"api_key", requestQuery{PageSize: 100, Sort: "api_key"}},
		{"model", requestQuery{PageSize: 100, Sort: "model"}},
		{"tokens", requestQuery{PageSize: 100, Sort: "tokens"}},
		{"credits", requestQuery{PageSize: 100, Sort: "credits"}},
		{"duration", requestQuery{PageSize: 100, Sort: "duration"}},
		{"failed", requestQuery{PageSize: 100, Status: "failed"}},
		{"success", requestQuery{PageSize: 100, Status: "success"}},
		{"failed_deep", requestQuery{PageSize: 100, Status: "failed", Page: deep / 10}},
		{"success_credits", requestQuery{PageSize: 100, Status: "success", Sort: "credits"}},
		{"failed_account", requestQuery{PageSize: 100, Status: "failed", Sort: "account"}},
		{"search_tokens", requestQuery{PageSize: 100, Search: "user7@", Sort: "tokens"}},
		{"error_type", requestQuery{PageSize: 100, ErrorType: "auth"}},
		{"count_success", requestQuery{PageSize: 1, Status: "success"}},
		{"count_failed", requestQuery{PageSize: 1, Status: "failed"}},
		{"search", requestQuery{PageSize: 100, Search: "user7@"}},
		{"search_none", requestQuery{PageSize: 100, Search: "no-such-thing"}},
		{"conversation", requestQuery{PageSize: 100, Conversation: fmt.Sprintf("conv-%d", rows/20)}},
		{"api_key_id", requestQuery{PageSize: 100, APIKeyID: "key-3"}},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				page, err := queryPersistedRequests(c.q)
				if err != nil {
					b.Fatal(err)
				}
				if page.Total == 0 && c.name != "search_none" {
					b.Fatalf("%s: empty page", c.name)
				}
			}
		})
	}
	b.Run("status_stats_full", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			requestLogChanged()
			if _, err := queryPersistedRequestStats(); err != nil {
				b.Fatal(err)
			}
		}
	})
	// A status poll with a request logged since the last one.
	b.Run("status_stats_poll", func(b *testing.B) {
		if _, err := queryPersistedRequestStats(); err != nil {
			b.Fatal(err)
		}
		for i := 0; i < b.N; i++ {
			b.StopTimer()
			if _, err := persistRequestRecord(requestRecord{TS: 1_800_000_000, AccountID: "acc-1", Model: "m", Success: true, TotalTokens: 10}); err != nil {
				b.Fatal(err)
			}
			b.StartTimer()
			if _, err := queryPersistedRequestStats(); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("traffic_history", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if _, err := queryTrafficHistory(time.Unix(1_700_000_000+int64(rows)*7, 0), 0); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// BenchmarkRequestLogInsert times logging one request into a seeded log, the write each
// proxied request makes; KIRO_BENCH_ROWS sets the log size as above.
func BenchmarkRequestLogInsert(b *testing.B) {
	rows := 20000
	if v, err := strconv.Atoi(os.Getenv("KIRO_BENCH_ROWS")); err == nil && v > 0 {
		rows = v
	}
	if err := db.ResetForTest(b.TempDir()); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = db.Close() })
	seedRequestLog(b, rows)
	rec := requestRecord{TS: 1_800_000_000, AccountID: "acc-1", APIKeyID: "key-1", Email: "user1@example.com", Model: "claude-sonnet-4.5",
		InTokens: 1200, OutTokens: 300, TotalTokens: 1500, Credits: 0.4, Success: true, Status: 200, Endpoint: "claude", DurationMs: 900,
		RequestID: "req-bench", ConversationID: "conv-bench", Client: "claude-code"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec.TotalTokens = 1500 + i%997
		rec.Credits = float64(i%89) / 10
		rec.DurationMs = int64(100 + i%4000)
		if _, err := persistRequestRecord(rec); err != nil {
			b.Fatal(err)
		}
	}
}
