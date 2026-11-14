package proxy

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
)

const (
	// maxStoredBodyBytes is the largest request body kept for replay; a bigger one
	// is served as usual but cannot be replayed.
	maxStoredBodyBytes = 2 << 20
	// requestBodiesRetention matches the Responses API state: 30 days.
	requestBodiesRetention = responsesRetention
	// maxRequestBodiesBytes caps the compressed bodies kept; the oldest go first.
	maxRequestBodiesBytesDefault int64 = 256 << 20
	// requestBodiesPruneEvery is how many stored bodies pass between prunes.
	requestBodiesPruneEvery = 50
)

// replayHeaders are the client headers a replay sends again; no credential is ever kept.
var replayHeaders = []string{"anthropic-beta", "anthropic-version"}

// maxRequestBodiesBytes is maxRequestBodiesBytesDefault; a test may lower it.
var maxRequestBodiesBytes = maxRequestBodiesBytesDefault

var (
	bodyEncoderOnce sync.Once
	bodyEncoder     *zstd.Encoder
	bodyDecoderOnce sync.Once
	bodyDecoder     *zstd.Decoder
	bodiesStored    atomic.Int64
)

func requestBodyEncoder() *zstd.Encoder {
	bodyEncoderOnce.Do(func() {
		bodyEncoder, _ = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(1))
	})
	return bodyEncoder
}

func requestBodyDecoder() *zstd.Decoder {
	bodyDecoderOnce.Do(func() {
		bodyDecoder, _ = zstd.NewReader(nil, zstd.WithDecoderMaxMemory(uint64(maxStoredBodyBytes)*2), zstd.WithDecoderConcurrency(1))
	})
	return bodyDecoder
}

// captureRequestBody keeps a client API request's body on its trace for replay.
// The body is in memory already (decompressRequestBody read it); this reads it
// again from there and puts it back. A body over maxStoredBodyBytes is not kept.
func captureRequestBody(r *http.Request) {
	trace := requestTraceFromContext(r.Context())
	if trace == nil || r.Body == nil || r.Body == http.NoBody {
		return
	}
	data, err := io.ReadAll(r.Body)
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(data))
	if err != nil || len(data) == 0 {
		return
	}
	trace.bodySize = len(data)
	if len(data) > maxStoredBodyBytes {
		return
	}
	trace.body = data
	headers := map[string]string{}
	for _, name := range replayHeaders {
		if v := r.Header.Get(name); v != "" {
			headers[name] = v
		}
	}
	if len(headers) > 0 {
		trace.headers = headers
	}
}

// noteConversation stamps the request with its conversation: the session
// affinity key the payload carries, the same for every turn of one conversation.
func noteConversation(ctx context.Context, payload *KiroPayload) {
	trace := requestTraceFromContext(ctx)
	if trace == nil || payload == nil {
		return
	}
	if key := affinityKey(payload); key != "" && trace.conversationID == "" {
		trace.conversationID = key
	}
}

// storeRequestBody keeps the body of logged request id, with the client's key
// masked wherever it appears. Only requests that reached an account are kept.
func storeRequestBody(id int64, trace *requestTrace, apiKey string, ts int64) {
	if trace == nil || len(trace.body) == 0 || id <= 0 {
		return
	}
	body := trace.body
	if key := strings.TrimSpace(apiKey); len(key) >= 8 {
		body = bytes.ReplaceAll(body, []byte(key), []byte(config.MaskApiKey(key)))
	}
	encoder := requestBodyEncoder()
	if encoder == nil {
		return
	}
	stored := encoder.EncodeAll(body, nil)
	headers := ""
	if len(trace.headers) > 0 {
		if raw, err := json.Marshal(trace.headers); err == nil {
			headers = string(raw)
		}
	}
	d, err := db.Get()
	if err != nil {
		return
	}
	if _, err := d.Exec(`INSERT OR REPLACE INTO request_bodies (request_id, created_at, endpoint, headers_json, size, stored_size, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, ts, trace.endpointName(), headers, len(body), len(stored), stored); err != nil {
		logger.Warnf("[Observe] Failed to keep a request body: %v", err)
		return
	}
	if bodiesStored.Add(1)%requestBodiesPruneEvery == 1 {
		if err := pruneRequestBodies(time.Now()); err != nil {
			logger.Warnf("[Observe] Failed to prune request bodies: %v", err)
		}
	}
}

// pruneRequestBodies drops bodies past their 30 days, bodies whose request row
// log retention removed, and the oldest ones while the total is over the cap.
func pruneRequestBodies(now time.Time) error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	if _, err := d.Exec(`DELETE FROM request_bodies WHERE created_at < ?`, now.Add(-requestBodiesRetention).Unix()); err != nil {
		return err
	}
	if _, err := d.Exec(`DELETE FROM request_bodies WHERE NOT EXISTS (SELECT 1 FROM requests r WHERE r.id = request_bodies.request_id)`); err != nil {
		return err
	}
	var total sql.NullInt64
	if err := d.QueryRow(`SELECT SUM(stored_size) FROM request_bodies`).Scan(&total); err != nil {
		return err
	}
	if !total.Valid || total.Int64 <= maxRequestBodiesBytes {
		return nil
	}
	//! Down to 90% of the cap, so the next few inserts do not prune again at once.
	excess := total.Int64 - maxRequestBodiesBytes*9/10
	_, err = d.Exec(`DELETE FROM request_bodies WHERE request_id IN (
  SELECT request_id FROM (
    SELECT request_id, SUM(stored_size) OVER (ORDER BY created_at, request_id) - stored_size AS before FROM request_bodies
  ) WHERE before < ?
)`, excess)
	return err
}

// storedRequestBody is a kept request body, ready to send again.
type storedRequestBody struct {
	Endpoint string
	Headers  map[string]string
	Body     []byte
	Size     int
}

var errRequestBodyMissing = errors.New("this request's body was not kept")

func loadRequestBody(id int64) (*storedRequestBody, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	var endpoint, headers string
	var size int
	var blob []byte
	err = d.QueryRow(`SELECT endpoint, headers_json, size, body FROM request_bodies WHERE request_id = ?`, id).Scan(&endpoint, &headers, &size, &blob)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errRequestBodyMissing
	}
	if err != nil {
		return nil, err
	}
	decoder := requestBodyDecoder()
	if decoder == nil {
		return nil, errRequestBodyMissing
	}
	body, err := decoder.DecodeAll(blob, nil)
	if err != nil {
		return nil, err
	}
	out := &storedRequestBody{Endpoint: endpoint, Body: body, Size: size}
	if headers != "" {
		_ = json.Unmarshal([]byte(headers), &out.Headers)
	}
	return out, nil
}
