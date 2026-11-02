package proxy

import (
	"errors"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"net/http"
	"sync/atomic"
	"time"
)

//! Narrating every earlier tool call as text left the model without a single example
//! of an assistant turn that issues a call, so long agent sessions degraded into
//! "Let me check X:" followed by a stop (upstream issue #170). Kiro accepts structured
//! historical toolUses/toolResults again (measured 2026-10-30, upstream PR #171), so
//! they are kept whenever the request can carry them safely.

// structuredToolHistoryRejectionTTL is how long a confirmed upstream rejection of
// structured tool history keeps every request on narrated history.
const structuredToolHistoryRejectionTTL = time.Hour

// structuredToolHistoryRejectedAt holds the UnixNano time of the last confirmed
// rejection, or 0.
var structuredToolHistoryRejectedAt atomic.Int64

func structuredToolHistoryEnabled() bool {
	if !config.GetStructuredToolHistory() {
		return false
	}
	at := structuredToolHistoryRejectedAt.Load()
	return at == 0 || time.Since(time.Unix(0, at)) >= structuredToolHistoryRejectionTTL
}

func markStructuredToolHistoryRejected() {
	structuredToolHistoryRejectedAt.Store(time.Now().UnixNano())
}

func resetStructuredToolHistoryRejection() {
	structuredToolHistoryRejectedAt.Store(0)
}

// structuredToolHistoryNames maps every name a historical toolUse may carry (the
// client name or the Kiro name) to the Kiro name declared in this request. It is
// nil when history must be narrated: the feature is off or recently rejected, or
// the request declares no tools (upstream answers TOOL_CONFIG_MISSING then).
func structuredToolHistoryNames(tools []KiroToolWrapper, nameMap map[string]string) map[string]string {
	if len(tools) == 0 || !structuredToolHistoryEnabled() {
		return nil
	}
	declared := make(map[string]string, len(tools)+len(nameMap))
	for _, tool := range tools {
		if name := tool.ToolSpecification.Name; name != "" {
			declared[name] = name
		}
	}
	for kiroName, clientName := range nameMap {
		if declared[kiroName] != "" {
			declared[clientName] = kiroName
		}
	}
	return declared
}

// sanitizeKiroHistoryForTools keeps adjacent toolUse/toolResult pairs structured
// when every name is declared, and narrates the rest exactly like sanitizeKiroHistory.
func sanitizeKiroHistoryForTools(history []KiroHistoryMessage, currentToolResultIDs map[string]bool, declared map[string]string) []KiroHistoryMessage {
	if len(declared) == 0 {
		return sanitizeKiroHistory(history, currentToolResultIDs)
	}
	history = sanitizeKiroHistoryKeeping(history, currentToolResultIDs, structuredToolPairs(history, declared))
	history = ensureToolHistoryPaired(history, currentToolResultIDs)
	for i := range history {
		a := history[i].AssistantResponseMessage
		if a == nil || len(a.ToolUses) == 0 {
			continue
		}
		//! Upstream emits and validates the declared (sanitized) names; clients replay their own.
		uses := append([]KiroToolUse(nil), a.ToolUses...)
		for j := range uses {
			if kiroName := declared[uses[j].Name]; kiroName != "" {
				uses[j].Name = kiroName
			}
		}
		a.ToolUses = uses
	}
	return history
}

// structuredToolPairs returns the indices of assistant toolUse turns and the user
// turns right after them whose toolResults answer exactly those calls. A nil
// declared map skips the name check.
func structuredToolPairs(history []KiroHistoryMessage, declared map[string]string) map[int]bool {
	var keep map[int]bool
	for i := 1; i+1 < len(history); i++ {
		a := history[i].AssistantResponseMessage
		u := history[i+1].UserInputMessage
		if a == nil || len(a.ToolUses) == 0 || u == nil || u.UserInputMessageContext == nil {
			continue
		}
		if !toolPairMatches(a.ToolUses, u.UserInputMessageContext.ToolResults, declared) {
			continue
		}
		if keep == nil {
			keep = make(map[int]bool)
		}
		keep[i], keep[i+1] = true, true
	}
	return keep
}

func toolPairMatches(uses []KiroToolUse, results []KiroToolResult, declared map[string]string) bool {
	if len(uses) == 0 || len(uses) != len(results) {
		return false
	}
	ids := make(map[string]bool, len(uses))
	for _, tu := range uses {
		if tu.ToolUseID == "" || ids[tu.ToolUseID] {
			return false
		}
		if declared != nil && declared[tu.Name] == "" {
			return false
		}
		ids[tu.ToolUseID] = true
	}
	for _, tr := range results {
		if !ids[tr.ToolUseID] {
			return false
		}
		delete(ids, tr.ToolUseID)
	}
	return true
}

// ensureToolHistoryPaired narrates structured tool turns that lost their partner,
// e.g. when truncation or leading-turn trimming cut a pair apart.
func ensureToolHistoryPaired(history []KiroHistoryMessage, currentToolResultIDs map[string]bool) []KiroHistoryMessage {
	for attempt := 0; attempt < 3; attempt++ {
		pairs := structuredToolPairs(history, nil)
		if toolHistoryPaired(history, currentToolResultIDs, pairs) {
			return history
		}
		history = sanitizeKiroHistoryKeeping(history, currentToolResultIDs, pairs)
	}
	if toolHistoryPaired(history, currentToolResultIDs, structuredToolPairs(history, nil)) {
		return history
	}
	return sanitizeKiroHistory(history, currentToolResultIDs)
}

func toolHistoryPaired(history []KiroHistoryMessage, currentToolResultIDs map[string]bool, pairs map[int]bool) bool {
	lastActive := currentToolResultsMatchLastAssistant(history, currentToolResultIDs)
	for i, msg := range history {
		if a := msg.AssistantResponseMessage; a != nil && len(a.ToolUses) > 0 && !pairs[i] && !(lastActive && i == len(history)-1) {
			return false
		}
		if u := msg.UserInputMessage; u != nil && u.UserInputMessageContext != nil && len(u.UserInputMessageContext.ToolResults) > 0 && !pairs[i] {
			return false
		}
	}
	return true
}

func currentPayloadToolResultIDs(payload *KiroPayload) map[string]bool {
	if ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext; ctx != nil {
		return collectToolResultIDs(ctx.ToolResults)
	}
	return nil
}

// payloadHasStructuredToolHistory reports structured tool turns beyond the active
// call the current message answers, which narrated mode keeps as well.
func payloadHasStructuredToolHistory(payload *KiroPayload) bool {
	if payload == nil {
		return false
	}
	history := payload.ConversationState.History
	lastActive := currentToolResultsMatchLastAssistant(history, currentPayloadToolResultIDs(payload))
	for i, msg := range history {
		if a := msg.AssistantResponseMessage; a != nil && len(a.ToolUses) > 0 && !(lastActive && i == len(history)-1) {
			return true
		}
		if u := msg.UserInputMessage; u != nil && u.UserInputMessageContext != nil && len(u.UserInputMessageContext.ToolResults) > 0 {
			return true
		}
	}
	return false
}

// flattenStructuredToolHistory rewrites the payload's history the way narrated
// mode builds it. It reports whether there was anything to flatten.
func flattenStructuredToolHistory(payload *KiroPayload) bool {
	if !payloadHasStructuredToolHistory(payload) {
		return false
	}
	ids := currentPayloadToolResultIDs(payload)
	history := payload.ConversationState.History
	for i := range history {
		a := history[i].AssistantResponseMessage
		if a == nil || len(a.ToolUses) == 0 {
			continue
		}
		//! Narration names the tool the way the client knows it.
		uses := append([]KiroToolUse(nil), a.ToolUses...)
		for j := range uses {
			if clientName, ok := payload.ToolNameMap[uses[j].Name]; ok {
				uses[j].Name = clientName
			}
		}
		copied := *a
		copied.ToolUses = uses
		history[i].AssistantResponseMessage = &copied
	}
	payload.ConversationState.History = sanitizeKiroHistory(history, ids)
	return true
}

// callWithToolHistoryFallback retries once with narrated history when upstream
// answers 400 to a payload that carried structured tool history. A 400 happens
// before any stream output, so the retry cannot duplicate text.
func callWithToolHistoryFallback(payload *KiroPayload, call func() error) error {
	err := call()
	if !isUpstreamBadRequest(err) || !flattenStructuredToolHistory(payload) {
		return err
	}
	logger.Warnf("[ToolHistory] Kiro rejected structured tool history (%v); retrying with narrated tool history", err)
	retryErr := call()
	if retryErr != nil && !isStreamIntegrityError(retryErr) {
		//! Only a narrated retry that reached a 200 stream proves tool history was the cause;
		//! a 4xx, 429, 5xx, network error or cancellation says nothing about it.
		return retryErr
	}
	markStructuredToolHistoryRejected()
	logger.Warnf("[ToolHistory] Narrated retry was accepted; narrating tool history for the next %s", structuredToolHistoryRejectionTTL)
	return retryErr
}

func isUpstreamBadRequest(err error) bool {
	var clientErr *upstreamClientError
	return errors.As(err, &clientErr) && clientErr.status == http.StatusBadRequest
}

func hasToolResults(msg *KiroUserInputMessage) bool {
	return msg != nil && msg.UserInputMessageContext != nil && len(msg.UserInputMessageContext.ToolResults) > 0
}
