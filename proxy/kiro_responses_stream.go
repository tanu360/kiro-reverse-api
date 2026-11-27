package proxy

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/logger"
)

//! CreateResponse answers with server-sent events: one JSON object per "data:" line, told
//! apart by "type" (the Kiro IDE's parseCreateResponseSse). responsesSSESource turns them into
//! the generateAssistantResponse events consumeKiroEvents already reads, so every client
//! format, the request log, credits and the stream integrity check work unchanged.

// maxResponsesSSELine is the longest server-sent event line read, the Kiro IDE's limit.
const maxResponsesSSELine = 4 << 20

// responsesSSEAdapter holds what one CreateResponse stream said so far.
type responsesSSEAdapter struct {
	scanner *bufio.Scanner
	queue   []kiroStreamEvent

	// callIDs maps a function_call item's id to its call_id; argument events name the item.
	callIDs map[string]string
	// lastCall is the call that started last, for argument events that name no item.
	lastCall string
	// open holds the calls started and not yet done.
	open map[string]bool
	// argued holds the calls whose arguments already arrived.
	argued map[string]bool
	// textStreamed holds the output_text and refusal parts (item and content index) that sent deltas.
	textStreamed map[string]bool
	// reasoningStreamed is whether the reasoning item in progress sent its text as deltas.
	reasoningStreamed bool
	// refused is whether the answer held a refusal part: the model declined, so the turn ends
	// with a refusal stop reason rather than END_TURN.
	refused bool
}

// responsesSSESource reads a CreateResponse event stream as generateAssistantResponse events.
func responsesSSESource(body io.Reader) kiroEventSource {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64<<10), maxResponsesSSELine)
	a := &responsesSSEAdapter{
		scanner:      scanner,
		callIDs:      map[string]string{},
		open:         map[string]bool{},
		argued:       map[string]bool{},
		textStreamed: map[string]bool{},
	}
	return a.next
}

func (a *responsesSSEAdapter) next() (kiroStreamEvent, error) {
	for len(a.queue) == 0 {
		if !a.scanner.Scan() {
			err := a.scanner.Err()
			switch {
			case err == nil:
				return kiroStreamEvent{}, io.EOF
			case errors.Is(err, bufio.ErrTooLong):
				return kiroStreamEvent{}, fmt.Errorf("%w: server-sent event line over %d bytes", errInvalidKiroEventStream, maxResponsesSSELine)
			default:
				return kiroStreamEvent{}, frameReadError(err)
			}
		}
		if err := a.line(a.scanner.Bytes()); err != nil {
			return kiroStreamEvent{}, err
		}
	}
	ev := a.queue[0]
	a.queue = a.queue[1:]
	return ev, nil
}

func (a *responsesSSEAdapter) emit(eventType string, event map[string]interface{}) {
	a.queue = append(a.queue, kiroStreamEvent{Type: eventType, Event: event})
}

func (a *responsesSSEAdapter) line(raw []byte) error {
	data, ok := strings.CutPrefix(string(raw), "data:")
	if !ok {
		//! event:, id:, retry: and comment lines carry nothing the type field does not.
		return nil
	}
	data = strings.TrimSpace(data)
	if data == "" || data == "[DONE]" {
		return nil
	}
	if data[0] != '{' {
		logger.Debugf("[KiroResponses] Skipping non-JSON event: %.200s", data)
		return nil
	}
	var event map[string]interface{}
	if err := json.Unmarshal([]byte(data), &event); err != nil {
		//! A dropped delta would silently corrupt the answer.
		return fmt.Errorf("%w: decode server-sent event: %v", errInvalidKiroEventStream, err)
	}
	if logger.GetLevel() <= logger.LevelDebug {
		logger.Debugf("[KiroResponses] Event: %s", shortenResponsesEventForLog(data))
	}
	return a.event(event)
}

func (a *responsesSSEAdapter) event(event map[string]interface{}) error {
	eventType, _ := event["type"].(string)
	switch eventType {
	case "response.output_text.delta":
		if delta, _ := event["delta"].(string); delta != "" {
			a.textStreamed[responsesPartKey(event)] = true
			a.emit("assistantResponseEvent", map[string]interface{}{"content": delta})
		}
	case "response.output_text.done":
		//! Only a part that sent no deltas: done repeats the whole text.
		if text, _ := event["text"].(string); text != "" && !a.textStreamed[responsesPartKey(event)] {
			a.emit("assistantResponseEvent", map[string]interface{}{"content": text})
		}
	case "response.refusal.delta":
		a.refused = true
		if delta, _ := event["delta"].(string); delta != "" {
			a.textStreamed[responsesPartKey(event)] = true
			a.emit("assistantResponseEvent", map[string]interface{}{"content": delta})
		}
	case "response.refusal.done":
		a.refused = true
		if refusal, _ := event["refusal"].(string); refusal != "" && !a.textStreamed[responsesPartKey(event)] {
			a.emit("assistantResponseEvent", map[string]interface{}{"content": refusal})
		}
	case "response.reasoning_text.delta", "response.reasoning.delta":
		if delta, _ := event["delta"].(string); delta != "" {
			a.reasoningStreamed = true
			a.emit("reasoningContentEvent", map[string]interface{}{"text": delta})
		}
	case "response.output_item.added":
		item, _ := event["item"].(map[string]interface{})
		switch item["type"] {
		case "reasoning":
			a.reasoningStreamed = false
		case "function_call":
			a.startCall(item)
		}
	case "response.function_call_arguments.delta":
		if delta, _ := event["delta"].(string); delta != "" {
			if id := a.callFor(event); id != "" {
				a.argued[id] = true
				a.emit("toolUseEvent", map[string]interface{}{"toolUseId": id, "input": delta})
			}
		}
	case "response.function_call_arguments.done":
		if id := a.callFor(event); id != "" && !a.argued[id] {
			if arguments, _ := event["arguments"].(string); arguments != "" {
				a.argued[id] = true
				a.emit("toolUseEvent", map[string]interface{}{"toolUseId": id, "input": arguments})
			}
		}
	case "response.output_item.done":
		item, _ := event["item"].(map[string]interface{})
		switch item["type"] {
		case "reasoning":
			a.reasoningDone(item)
		case "function_call":
			a.finishCall(item)
		}
	case "response.completed", "response.incomplete":
		a.completed(eventType, event)
	case "response.failed":
		response, _ := event["response"].(map[string]interface{})
		failure, _ := response["error"].(map[string]interface{})
		return responsesStreamFailure(failure)
	case "error":
		failure, ok := event["error"].(map[string]interface{})
		if !ok {
			failure = event
		}
		return responsesStreamFailure(failure)
	}
	//! kiro:keep_alive, kiro:code_reference.added, response.created / in_progress and the
	//! content_part events carry nothing a client response needs.
	return nil
}

// responsesPartKey names an output_text or refusal part: its item and content index.
func responsesPartKey(event map[string]interface{}) string {
	itemID, _ := event["item_id"].(string)
	return itemID + "\x00" + fmt.Sprint(event["content_index"])
}

func (a *responsesSSEAdapter) startCall(item map[string]interface{}) {
	id := firstStringField(item, "call_id", "id")
	if id == "" {
		return
	}
	if itemID, _ := item["id"].(string); itemID != "" {
		a.callIDs[itemID] = id
	}
	a.lastCall = id
	a.open[id] = true
	event := map[string]interface{}{"toolUseId": id, "name": item["name"]}
	if arguments, _ := item["arguments"].(string); arguments != "" {
		a.argued[id] = true
		event["input"] = arguments
	}
	a.emit("toolUseEvent", event)
}

// callFor is the call an argument event belongs to: the one its item_id names, else the call
// that started last.
func (a *responsesSSEAdapter) callFor(event map[string]interface{}) string {
	if itemID, _ := event["item_id"].(string); itemID != "" {
		if id, ok := a.callIDs[itemID]; ok {
			return id
		}
	}
	if id, _ := event["call_id"].(string); id != "" && a.open[id] {
		return id
	}
	return a.lastCall
}

func (a *responsesSSEAdapter) finishCall(item map[string]interface{}) {
	id := firstStringField(item, "call_id", "id")
	if itemID, _ := item["id"].(string); itemID != "" {
		if mapped, ok := a.callIDs[itemID]; ok {
			id = mapped
		}
	}
	if id == "" {
		return
	}
	if !a.open[id] {
		//! A call that arrives whole, with no output_item.added before it.
		if name, _ := item["name"].(string); name == "" || a.argued[id] {
			return
		}
		a.startCall(item)
	}
	delete(a.open, id)
	if status, _ := item["status"].(string); status == "incomplete" {
		//! The IDE drops a call Kiro could not finish rather than run it with partial arguments.
		a.emit(kiroToolUseDropEvent, map[string]interface{}{"toolUseId": id})
		return
	}
	if arguments, _ := item["arguments"].(string); arguments != "" && !a.argued[id] {
		a.argued[id] = true
		a.emit("toolUseEvent", map[string]interface{}{"toolUseId": id, "input": arguments})
	}
	a.emit("toolUseEvent", map[string]interface{}{"toolUseId": id, "stop": true})
}

// reasoningDone reads a finished reasoning item's envelope: {"reasoningText": {text, signature}}
// or {"redactedContent": "..."}, as a JSON string in encrypted_content.
func (a *responsesSSEAdapter) reasoningDone(item map[string]interface{}) {
	raw, _ := item["encrypted_content"].(string)
	var envelope kiroReasoningContent
	if raw == "" || json.Unmarshal([]byte(raw), &envelope) != nil {
		return
	}
	if rt := envelope.ReasoningText; rt != nil {
		if rt.Text != "" && !a.reasoningStreamed {
			a.emit("reasoningContentEvent", map[string]interface{}{"text": rt.Text})
		}
		if rt.Signature != "" {
			a.emit("reasoningContentEvent", map[string]interface{}{"signature": rt.Signature})
		}
	}
	if envelope.RedactedContent != "" {
		a.emit("reasoningContentEvent", map[string]interface{}{"redactedContent": envelope.RedactedContent})
	}
	a.reasoningStreamed = false
}

// responsesStopReasons are the IDE's stop reasons for an incomplete response.
var responsesStopReasons = map[string]string{
	"max_output_tokens":                     "MAX_TOKENS",
	"content_filter":                        "CONTENT_FILTERED",
	"compaction_required_for_model_handoff": "COMPACTION_REQUIRED_FOR_MODEL_HANDOFF",
}

// completed turns the closing event into the stop reason, context usage and metering events.
// Its usage carries Kiro's credits and context occupancy, not token counts.
func (a *responsesSSEAdapter) completed(eventType string, event map[string]interface{}) {
	response, _ := event["response"].(map[string]interface{})
	stopReason := "END_TURN"
	if status, _ := response["status"].(string); eventType == "response.incomplete" || status == "incomplete" {
		details, _ := response["incomplete_details"].(map[string]interface{})
		reason, _ := details["reason"].(string)
		if mapped, ok := responsesStopReasons[reason]; ok {
			stopReason = mapped
		} else if reason != "" {
			stopReason = strings.ToUpper(reason)
		}
	}
	if a.refused && stopReason == "END_TURN" {
		stopReason = "REFUSAL"
	}
	metadata := map[string]interface{}{"stopReason": stopReason}
	usage, _ := response["usage"].(map[string]interface{})
	if usage != nil {
		//! Token counts, should Kiro ever send them, are read from here like any other usage map.
		metadata["usage"] = usage
	}
	a.emit("metadataEvent", metadata)
	if pct, ok := usage["kiro:context_usage_percentage"].(float64); ok && !math.IsNaN(pct) && !math.IsInf(pct, 0) {
		a.emit("contextUsageEvent", map[string]interface{}{"contextUsagePercentage": pct})
	}
	if credits, ok := usage["kiro:credits"].(map[string]interface{}); ok {
		if value, ok := credits["value"].(float64); ok && !math.IsNaN(value) && !math.IsInf(value, 0) {
			a.emit("meteringEvent", map[string]interface{}{"usage": value})
		}
	}
}

func shortenResponsesEventForLog(data string) string {
	const limit = 2000
	if len(data) <= limit {
		return data
	}
	return data[:limit] + fmt.Sprintf("… (%d bytes)", len(data))
}

// ---- Errors ----------------------------------------------------------------------------

// responsesErrorReasons are the IDE's CreateResponse error codes in generateAssistantResponse's
// reasons (its normalizeReason).
var responsesErrorReasons = map[string]string{
	"rate_limit_exceeded":             "USER_REQUEST_RATE_EXCEEDED",
	"context_length_exceeded":         "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
	"server_is_overloaded":            "MODEL_TEMPORARILY_UNAVAILABLE",
	"model_not_found":                 "INVALID_MODEL_ID",
	"invalid_function_parameters":     "TOOL_SCHEMA_INVALID",
	"invalid_json":                    "REQUEST_BODY_INVALID_JSON",
	"kiro:model_requires_user_opt_in": "MODEL_REQUIRES_USER_OPT_IN",
}

// responsesErrorTypes are the error types the IDE reads from a stream error that has a code alone.
var responsesErrorTypes = map[string]bool{
	"invalid_request":    true,
	"not_found":          true,
	"too_many_requests":  true,
	"insufficient_quota": true,
	"server_error":       true,
	"model_error":        true,
}

// responsesFailure is a CreateResponse refusal: an HTTP error answer or an error event.
type responsesFailure struct {
	status     int // 0 for an error event in a 200 stream
	errType    string
	code       string
	message    string
	retryAfter time.Duration
}

func responsesReason(status int, code string) string {
	if status == http.StatusRequestEntityTooLarge {
		return "CONTENT_LENGTH_EXCEEDS_THRESHOLD"
	}
	if code == "" {
		return ""
	}
	if reason, ok := responsesErrorReasons[code]; ok {
		return reason
	}
	if rest, ok := strings.CutPrefix(code, "kiro:"); ok {
		return strings.ToUpper(rest)
	}
	return code
}

// legacyBody is the refusal in generateAssistantResponse's words, {"message","reason"}, so
// the messages the account failover reads look the same on both APIs.
func (f responsesFailure) legacyBody() string {
	out := map[string]interface{}{"message": f.message}
	if reason := responsesReason(f.status, f.code); reason != "" {
		out["reason"] = reason
	}
	encoded, _ := json.Marshal(out)
	return string(encoded)
}

func (f responsesFailure) is(values ...string) bool {
	for _, v := range values {
		if f.code == v || f.errType == v {
			return true
		}
	}
	return false
}

// proxyError is the failure as the error types the account failover and the client error
// responses understand. The texts keep the markers the failover reads: an HTTP status, "429"
// for a throttle and "quota exhausted" for spent credits.
func (f responsesFailure) proxyError() error {
	body := f.legacyBody()
	text := fmt.Sprintf("HTTP %d from %s: %s", f.status, kiroResponsesEndpointName, body)
	if f.status == 0 {
		text = fmt.Sprintf("%s stream error: %s", kiroResponsesEndpointName, body)
	}
	switch {
	case f.status == http.StatusPaymentRequired || f.is("insufficient_quota", "credit_balance_exhausted"):
		//! Spent credits: the account rests until its quota is back, as after a MONTHLY_REQUEST_COUNT 429.
		if !isUsageQuotaExhaustedMessage(text) {
			text += " (quota exhausted)"
		}
		return &upstreamQuotaError{message: text, retryFor: f.retryAfter, throttled: false}
	case f.status == http.StatusTooManyRequests || f.is("rate_limit_exceeded", "too_many_requests"):
		if f.status == 0 {
			text = fmt.Sprintf("%s stream error (429): %s", kiroResponsesEndpointName, body)
		}
		return &upstreamQuotaError{message: text, retryFor: f.retryAfter, throttled: !isUsageQuotaExhaustedMessage(body)}
	case f.status == http.StatusRequestEntityTooLarge || f.is("context_length_exceeded"):
		//! generateAssistantResponse says this with a 400 ("Input is too long."); clients that
		//! compact a long conversation look for a 400.
		return &upstreamClientError{status: http.StatusBadRequest, message: text}
	case f.status == http.StatusUnauthorized || f.status == http.StatusForbidden:
		return errors.New(text)
	case isClientHTTPStatus(f.status):
		return &upstreamClientError{status: f.status, message: text}
	case f.status == 0 && f.is("invalid_request", "not_found", "invalid_function_parameters", "invalid_json",
		"model_not_found", "kiro:model_requires_user_opt_in"):
		return &upstreamClientError{status: http.StatusBadRequest, message: text}
	case f.status == 0:
		//! Overloaded or a server fault mid-stream: an upstream hiccup, retried like an event-stream exception.
		return fmt.Errorf("%w: %s", errKiroEventStreamUpstream, text)
	}
	return errors.New(text)
}

// responsesStreamFailure is an error or response.failed event's error: {type, code, message}.
func responsesStreamFailure(e map[string]interface{}) error {
	f := responsesFailure{}
	f.errType, _ = e["type"].(string)
	if f.errType == "error" {
		f.errType = ""
	}
	f.code, _ = e["code"].(string)
	if f.errType == "" && responsesErrorTypes[f.code] {
		f.errType, f.code = f.code, ""
	}
	f.message, _ = e["message"].(string)
	if f.message == "" {
		f.message = "CreateResponse stream failed (" + firstNonEmpty(f.errType, f.code, "unknown") + ")"
	}
	return f.proxyError()
}

// responsesHTTPFailure reads a non-200 CreateResponse answer: {"error": {message, type, code}}
// or Kiro's {"message", "reason", "__type"}, with retryAfterMilliseconds.
func responsesHTTPFailure(status int, header http.Header, body []byte, now time.Time) error {
	f := responsesFailure{status: status}
	var parsed struct {
		Error *struct {
			Message string          `json:"message"`
			Type    string          `json:"type"`
			Code    json.RawMessage `json:"code"`
		} `json:"error"`
		Message                string   `json:"message"`
		MessageUpper           string   `json:"Message"`
		Reason                 string   `json:"reason"`
		Type                   string   `json:"__type"`
		RetryAfterMilliseconds *float64 `json:"retryAfterMilliseconds"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		if e := parsed.Error; e != nil {
			f.message, f.errType = e.Message, e.Type
			_ = json.Unmarshal(e.Code, &f.code)
		}
		f.message = firstNonEmpty(f.message, parsed.Message, parsed.MessageUpper)
		if f.code == "" {
			f.code = parsed.Reason
		}
		if f.errType == "" {
			f.errType = parsed.Type
		}
	}
	if f.message == "" {
		f.message = strings.TrimSpace(string(body))
	}
	if f.message == "" {
		f.message = fmt.Sprintf("CreateResponse HTTP %d", status)
	}
	f.retryAfter = responsesRetryAfter(header, parsed.RetryAfterMilliseconds, now)
	return f.proxyError()
}

// responsesRetryAfter is the wait Kiro asked for: x-amzn-kiro-ratelimit-retry-after
// (milliseconds), else the body's retryAfterMilliseconds, else Retry-After. At most an hour.
func responsesRetryAfter(header http.Header, bodyMillis *float64, now time.Time) time.Duration {
	const limit = time.Hour
	millis := func(ms float64) time.Duration {
		if math.IsNaN(ms) || ms <= 0 {
			return 0
		}
		if ms >= float64(limit/time.Millisecond) {
			return limit
		}
		return time.Duration(ms * float64(time.Millisecond))
	}
	if v := strings.TrimSpace(header.Get("x-amzn-kiro-ratelimit-retry-after")); v != "" {
		if ms, err := strconv.ParseFloat(v, 64); err == nil && ms > 0 {
			return millis(ms)
		}
	}
	if bodyMillis != nil && *bodyMillis > 0 {
		return millis(*bodyMillis)
	}
	return retryAfterDuration(header.Get("Retry-After"), now)
}
