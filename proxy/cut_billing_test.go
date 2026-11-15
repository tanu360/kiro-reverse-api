package proxy

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
	accountpool "kiro-proxy/pool"
)

// cutBillingCredits is the billing event of the fake replies below.
const cutBillingCredits = 0.0702

// setCutBillingGrace sets cutBillingGrace for one test.
func setCutBillingGrace(t *testing.T, grace time.Duration) {
	t.Helper()
	old := cutBillingGrace
	cutBillingGrace = grace
	t.Cleanup(func() { cutBillingGrace = old })
}

// heldTrailerUpstream sends cutTestChunks at once and holds the billing event until release
// closes; gone closes when the proxy ends the stream first.
type heldTrailerUpstream struct {
	release chan struct{}
	gone    chan struct{}
	sent    atomic.Bool
}

func newHeldTrailerUpstream() *heldTrailerUpstream {
	return &heldTrailerUpstream{release: make(chan struct{}), gone: make(chan struct{})}
}

func (u *heldTrailerUpstream) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var answer []byte
		for _, chunk := range cutTestChunks {
			answer = append(answer, answerFrame(t, chunk)...)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(answer)
		w.(http.Flusher).Flush()
		select {
		case <-u.release:
			_, _ = w.Write(awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": cutBillingCredits}))
			u.sent.Store(true)
		case <-r.Context().Done():
			close(u.gone)
		case <-time.After(10 * time.Second):
		}
	}
}

// loggedCredits reads the credits of the request log's newest row from the database.
func loggedCredits(t *testing.T) (int64, float64) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	var id int64
	var credits float64
	if err := d.QueryRow(`SELECT id, credits FROM requests ORDER BY id DESC LIMIT 1`).Scan(&id, &credits); err != nil {
		t.Fatal(err)
	}
	return id, credits
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func accountTotalCredits(id string) float64 {
	for _, acc := range accountpool.GetPool().GetAllAccounts() {
		if acc.ID == id {
			return acc.TotalCredits
		}
	}
	return -1
}

// A reply the limiter cut ends for the client at once; the billing event Kiro sends after the
// cut is still counted on the request's log row, the account, the API key and the windows.
func TestCutReplyBillingArrivingLaterLandsOnTheRequest(t *testing.T) {
	setCutBillingGrace(t, 5*time.Second)
	for _, c := range []struct{ name, path, body string }{
		{"messages", "/v1/messages", `{"model":"claude-haiku-4.5","max_tokens":8,"messages":[{"role":"user","content":"Count from 1 to 30."}]}`},
		{"messages stream stop sequence", "/v1/messages", `{"model":"claude-haiku-4.5","max_tokens":1024,"stream":true,"stop_sequences":["12"],"messages":[{"role":"user","content":"Count from 1 to 30."}]}`},
		{"chat stream", "/v1/chat/completions", `{"model":"claude-haiku-4.5","max_tokens":8,"stream":true,"messages":[{"role":"user","content":"Count from 1 to 30."}]}`},
		{"responses", "/v1/responses", `{"model":"claude-haiku-4.5","max_output_tokens":16,"store":false,"input":"Count from 1 to 30."}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			upstream := newHeldTrailerUpstream()
			h := newStreamTestHandler(t, upstream.handler(t))
			requireKey := true
			if err := config.UpdateSettingsPatch(&requireKey, ""); err != nil {
				t.Fatal(err)
			}
			key, err := config.AddApiKey(config.ApiKeyEntry{Name: "cut", Key: "sk-cut-billing", Enabled: true})
			if err != nil {
				t.Fatal(err)
			}

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, c.path, strings.NewReader(c.body))
			req.Header.Set("Authorization", "Bearer sk-cut-billing")
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
			}
			//! The client's answer came back while Kiro still held its billing event.
			if upstream.sent.Load() {
				t.Fatal("the response waited for the billing event")
			}
			id, credits := loggedCredits(t)
			if credits != 0 {
				t.Fatalf("logged %v credits before the billing event", credits)
			}

			close(upstream.release)
			waitFor(t, "the late credits on the log row", func() bool {
				_, credits = loggedCredits(t)
				return credits != 0
			})
			if !near(credits, cutBillingCredits) {
				t.Fatalf("log row credits = %v, want %v", credits, cutBillingCredits)
			}
			recent := getObserveStore().RecentRequests(1)
			if len(recent) != 1 || recent[0].ID != id || !near(recent[0].Credits, cutBillingCredits) {
				t.Fatalf("recent requests = %+v, want row %d with the late credits", recent, id)
			}
			if got := accountTotalCredits("only"); !near(got, cutBillingCredits) {
				t.Fatalf("account total credits = %v, want %v", got, cutBillingCredits)
			}
			if entry := config.GetApiKeyEntry(key.ID); entry == nil || !near(entry.CreditsUsed, cutBillingCredits) || entry.SuccessfulCalls != 1 {
				t.Fatalf("API key usage = %+v, want %v credits over one call", entry, cutBillingCredits)
			}
			stats, err := queryPersistedRequestStats()
			if err != nil || !near(stats.SuccessCredits, cutBillingCredits) {
				t.Fatalf("persisted stats = %+v (%v), want %v credits", stats, err, cutBillingCredits)
			}
			var windowCredits float64
			s := getObserveStore()
			s.mu.RLock()
			for _, b := range s.globalRing {
				windowCredits += b.Credits
			}
			modelCredits := s.modelStats["claude-haiku-4.5"]
			s.mu.RUnlock()
			if !near(windowCredits, cutBillingCredits) || modelCredits == nil || !near(modelCredits.Credits, cutBillingCredits) {
				t.Fatalf("window credits = %v, model stats = %+v; want %v in both", windowCredits, modelCredits, cutBillingCredits)
			}
		})
	}
}

// Without a billing event in the grace (Kiro was still writing the reply, so it bills nothing),
// the cut stream is closed and the request keeps 0 credits.
func TestCutReplyStreamIsClosedAfterTheGrace(t *testing.T) {
	setCutBillingGrace(t, 50*time.Millisecond)
	upstream := newHeldTrailerUpstream()
	h := newStreamTestHandler(t, upstream.handler(t))
	start := time.Now()
	postOK(t, h, "/v1/messages", `{"model":"claude-haiku-4.5","max_tokens":8,"messages":[{"role":"user","content":"Count from 1 to 30."}]}`)
	select {
	case <-upstream.gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the cut stream was never closed")
	}
	if waited := time.Since(start); waited > 3*time.Second {
		t.Fatalf("closed after %s", waited)
	}
	if _, credits := loggedCredits(t); credits != 0 {
		t.Fatalf("logged %v credits for a reply Kiro never billed", credits)
	}
}

// A client that leaves before any cut still ends the upstream stream at once.
func TestClientGoneBeforeTheCutStillEndsTheStream(t *testing.T) {
	setCutBillingGrace(t, 5*time.Second)
	upstream := newHeldTrailerUpstream()
	newStreamTestHandler(t, upstream.handler(t))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- CallKiroAPIContext(ctx, testAccount(t), testKiroPayload(), &KiroStreamCallback{
			OnText: func(string, bool) { cancel() },
		})
	}()
	select {
	case <-upstream.gone:
	case <-time.After(3 * time.Second):
		t.Fatal("a gone client left the upstream stream open")
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

// The billing event can come before the request is logged; it is counted once it is.
func TestLateCreditsBeforeTheRequestIsLogged(t *testing.T) {
	trace := &requestTrace{}
	var applied []float64
	trace.addLateCredits("a", 0.25)
	trace.onLateCredits(func(_ string, credits float64) { applied = append(applied, credits) })
	trace.addLateCredits("a", 0.5)
	trace.addLateCredits("a", 0)
	if len(applied) != 2 || applied[0] != 0.25 || applied[1] != 0.5 {
		t.Fatalf("applied = %v, want [0.25 0.5]", applied)
	}
	var none *requestTrace
	none.addLateCredits("a", 1)
	none.onLateCredits(func(string, float64) { t.Fatal("a nil trace applies nothing") })
}

func TestUpstreamStreamContextOutlivesOnlyACut(t *testing.T) {
	parent, cancel := context.WithCancelCause(context.Background())
	stream, end := upstreamStreamContext(parent)
	cancel(errOutputLimitReached)
	time.Sleep(20 * time.Millisecond)
	if stream.Err() != nil {
		t.Fatal("a cut ended the stream")
	}
	end(errCutGraceOver)
	if !errors.Is(context.Cause(stream), errCutGraceOver) {
		t.Fatalf("cause = %v", context.Cause(stream))
	}

	parent, cancel = context.WithCancelCause(context.Background())
	stream, end = upstreamStreamContext(parent)
	defer end(nil)
	cancel(context.Canceled)
	select {
	case <-stream.Done():
	case <-time.After(time.Second):
		t.Fatal("a gone client did not end the stream")
	}
}

// pipeResponses answers CreateResponse with a body the test writes as it goes.
func pipeResponses(t *testing.T) (*io.PipeWriter, *atomic.Int32) {
	t.Helper()
	reader, writer := io.Pipe()
	var calls atomic.Int32
	old := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		h := http.Header{}
		h.Set("Content-Type", "text/event-stream")
		return &http.Response{StatusCode: http.StatusOK, Header: h, Body: reader}, nil
	})})
	t.Cleanup(func() {
		kiroHttpStore.Store(old)
		_ = writer.Close()
	})
	return writer, &calls
}

// The same on CreateResponse: response.completed carries the credits (recorded live, scrubbed).
func TestCutResponsesReplyBillingArrivingLaterLandsOnTheRequest(t *testing.T) {
	setCutBillingGrace(t, 5*time.Second)
	h := newStreamTestHandler(t, http.NotFound)
	if err := config.UpdateChatAPI(config.ChatAPIResponses); err != nil {
		t.Fatal(err)
	}
	writer, calls := pipeResponses(t)
	cut := strings.Index(recordedResponsesText, `data: {"type":"response.output_text.done"`)
	head, tail := recordedResponsesText[:cut], recordedResponsesText[cut:]
	go func() { _, _ = io.WriteString(writer, head) }()

	rec := postOK(t, h, "/v1/messages", `{"model":"claude-haiku-4.5","max_tokens":1024,"stop_sequences":["ng"],"messages":[{"role":"user","content":"ping"}]}`)
	if !strings.Contains(rec.Body.String(), `"stop_reason":"stop_sequence"`) {
		t.Fatalf("body %s, want a stop at the sequence", rec.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("CreateResponse calls = %d", calls.Load())
	}
	if _, credits := loggedCredits(t); credits != 0 {
		t.Fatalf("logged %v credits before the billing event", credits)
	}
	go func() {
		_, _ = io.WriteString(writer, tail)
		_ = writer.Close()
	}()
	const want = 0.005392237810945275
	waitFor(t, "the late credits on the log row", func() bool {
		_, credits := loggedCredits(t)
		return near(credits, want)
	})
	if got := accountTotalCredits("only"); !near(got, want) {
		t.Fatalf("account total credits = %v, want %v", got, want)
	}
}

// A continuation the output limiter cuts ends the turn; the hops before it were billed and keep
// their credits.
func TestAutoContinueKeepsFinishedHopsCreditsWhenALaterHopIsCut(t *testing.T) {
	rec, _, err := runScriptedContinue(t, testKiroPayload(), 3,
		scriptedHop{text: []string{"Part one, "}, stop: "max_tokens", in: 100, out: 8192, credits: 0.5},
		scriptedHop{text: []string{"part"}, err: context.Canceled},
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the cut hop's cancel", err)
	}
	if rec.credits != 0.5 {
		t.Fatalf("credits = %v, want the first hop's 0.5", rec.credits)
	}
}
