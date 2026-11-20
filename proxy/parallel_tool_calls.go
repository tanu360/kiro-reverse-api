package proxy

import (
	"encoding/json"
	"sync/atomic"

	"kiro-proxy/logger"
)

//! Kiro has no switch for parallel tool calls. An Anthropic client that sets
//! tool_choice.disable_parallel_tool_use gets a directive in the user turn, and only the
//! first call of the reply reaches it; before, "weather in Rome and Paris?" came back with
//! two calls (live, 2026-11-20). Claude Code never sets it, so its turns are unchanged.
//!
//! OpenAI's parallel_tool_calls false stays unenforced: Codex 0.146 sent it by default
//! (see TestIssue151CodexPayloadRoundTripsThroughKiro) and handles several calls a turn,
//! so one call per turn would only slow it down. Codex 0.171 sends true.

// singleToolCallDirective asks the model for one tool call on this turn.
const singleToolCallDirective = "The client accepts at most one tool call on this turn. Do not call tools in parallel."

// claudeDisablesParallelToolUse reports whether an Anthropic tool_choice sets
// disable_parallel_tool_use.
func claudeDisablesParallelToolUse(value interface{}) bool {
	if value == nil {
		return false
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var choice struct {
		DisableParallelToolUse bool `json:"disable_parallel_tool_use"`
	}
	if json.Unmarshal(raw, &choice) != nil {
		return false
	}
	return choice.DisableParallelToolUse
}

// withSingleToolCall passes the reply's first tool call and drops the rest.
func withSingleToolCall(callback *KiroStreamCallback) *KiroStreamCallback {
	if callback == nil || callback.OnToolUse == nil {
		return callback
	}
	next := callback.OnToolUse
	var called atomic.Bool
	wrapped := *callback
	wrapped.OnToolUse = func(tu KiroToolUse) {
		if called.Swap(true) {
			logger.Infof("[ToolChoice] Dropped tool call %s (%s): the client turned parallel tool use off", tu.ToolUseID, tu.Name)
			return
		}
		next(tu)
	}
	return &wrapped
}
