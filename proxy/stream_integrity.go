package proxy

import (
	"errors"
	"strings"
)

var (
	errEmptyKiroStream           = errors.New("upstream stream ended before any output")
	errUpstreamTruncatedResponse = errors.New("upstream truncated response without stop reason")
	errIncompleteKiroToolInput   = errors.New("upstream stream ended with incomplete tool input")
	errInvalidKiroEventStream    = errors.New("invalid upstream event stream")
	errKiroEventStreamUpstream   = errors.New("upstream event stream error")
)

type streamTurnSignals struct {
	//! What one upstream stream proved about its own completeness.
	sawContent   bool
	sawReasoning bool
	toolCount    int
	stopReason   string
	// Only metering confirms a completed turn; context occupancy can arrive before completion.
	sawTrailer bool
}

func classifyStreamIntegrity(turn streamTurnSignals) error {
	//! A clean EOF proves nothing: a stream that died mid-answer looks like a finished one.
	//! stopReason only rides in metadataEvent, which IdC / Enterprise accounts never send
	//! (upstream Kiro-Go #147, #158), so answer text plus metering also counts as complete.
	//! Reasoning without an answer stays truncated: metering bills thinking even when the turn died.
	switch {
	case turn.toolCount > 0:
		return nil
	case !turn.sawContent && !turn.sawReasoning:
		return errEmptyKiroStream
	case strings.TrimSpace(turn.stopReason) != "":
		return nil
	case turn.sawContent && turn.sawTrailer:
		return nil
	default:
		return errUpstreamTruncatedResponse
	}
}

func eventStopReason(event map[string]interface{}) string {
	if reason := firstStringField(event, "stopReason", "stop_reason", "finishReason", "finish_reason"); reason != "" {
		return reason
	}
	// Restrict traversal to protocol envelopes, never tool arguments or arbitrary content.
	for _, key := range []string{"metadata", "metadataEvent", "assistantResponseEvent"} {
		if nested, ok := event[key].(map[string]interface{}); ok {
			if reason := firstStringField(nested, "stopReason", "stop_reason", "finishReason", "finish_reason"); reason != "" {
				return reason
			}
		}
	}
	return ""
}

func isStreamIntegrityError(err error) bool {
	//! Integrity failures are upstream hiccups, not account faults: retry them, but never cool the account down.
	return errors.Is(err, errEmptyKiroStream) ||
		errors.Is(err, errUpstreamTruncatedResponse) ||
		errors.Is(err, errIncompleteKiroToolInput) ||
		errors.Is(err, errInvalidKiroEventStream)
}

func normalizeStopReason(reason string) string {
	return strings.ToLower(strings.TrimSpace(reason))
}

func mapClaudeStopReason(reason string, toolCount int) string {
	if toolCount > 0 {
		return "tool_use"
	}
	switch normalizeStopReason(reason) {
	case "max_tokens", "max_output_tokens", "length":
		return "max_tokens"
	case "model_context_window_exceeded", "context_window_exceeded":
		return "model_context_window_exceeded"
	case "refusal", "content_filter", "content_filtered", "guardrail_intervened":
		return "refusal"
	case "stop_sequence":
		return "stop_sequence"
	case "pause_turn":
		return "pause_turn"
	default:
		return "end_turn"
	}
}

func mapOpenAIFinishReason(reason string, toolCount int) string {
	if toolCount > 0 {
		return "tool_calls"
	}
	switch normalizeStopReason(reason) {
	case "max_tokens", "max_output_tokens", "length", "model_context_window_exceeded", "context_window_exceeded":
		return "length"
	case "refusal", "content_filter", "content_filtered", "guardrail_intervened":
		return "content_filter"
	default:
		return "stop"
	}
}

func mapResponsesCompletion(reason string) (status, incompleteReason string) {
	//! mapResponsesCompletion returns the Responses API status and incomplete_details.reason.
	switch normalizeStopReason(reason) {
	case "max_tokens", "max_output_tokens", "length", "model_context_window_exceeded", "context_window_exceeded":
		return "incomplete", "max_output_tokens"
	case "refusal", "content_filter", "content_filtered", "guardrail_intervened":
		return "incomplete", "content_filter"
	default:
		return "completed", ""
	}
}
