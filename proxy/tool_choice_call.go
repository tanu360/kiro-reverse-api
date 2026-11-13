package proxy

import (
	"context"
	"fmt"
	"strings"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

//! Kiro has no tool_choice, so a required tool call rides in the user turn as a directive, and
//! the model may still answer in text ("which city?" for a forced get_weather). The turn is
//! held until it ends: with a tool call it goes out as it came; without one it is asked for
//! again once, with the first reply in the history and a firmer directive. A retry that still
//! makes no call leaves the first reply as the answer. Reasoning streams at once.

// callKiroForcedTool runs a request whose tool_choice requires a tool call.
func callKiroForcedTool(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback, call kiroCallFunc) error {
	choice := payload.ForcedToolChoice
	inner := *payload
	inner.ForcedToolChoice = ""
	first := &structuredAttempt{downstream: callback, forwardThinking: true}
	if err := callKiroAutoContinue(ctx, account, &inner, first.callback(), call); err != nil {
		return err
	}
	first.flush()
	maxTokens := requestedMaxTokens(&inner)
	if len(first.toolUses) > 0 || !first.canRetry(&inner) || ctx.Err() != nil {
		finishStructured(callback, maxTokens, first, first.answer.String(), first)
		return nil
	}

	logger.Infof("[ToolChoice] The reply made no tool call though the client requires one; asking once more")
	base := &inner
	if first.followup != nil {
		base = first.followup
	}
	retry := &structuredAttempt{downstream: callback}
	err := callKiroAutoContinue(ctx, account, forcedToolRetryPayload(base, choice, first.answer.String()), retry.callback(), call)
	if err != nil {
		if isContextCanceledError(err) || ctx.Err() != nil {
			return err
		}
		logger.Warnf("[ToolChoice] The second try failed, keeping the first reply: %v", err)
		finishStructured(callback, maxTokens, first, first.answer.String(), first, retry)
		return nil
	}
	retry.flush()
	if len(retry.toolUses) == 0 {
		logger.Warnf("[ToolChoice] The second try made no tool call either; keeping the first reply")
		finishStructured(callback, maxTokens, first, first.answer.String(), first, retry)
		return nil
	}
	finishStructured(callback, maxTokens, retry, retry.answer.String(), first, retry)
	return nil
}

// forcedToolRetryPayload replays the turn with the reply that made no call and asks for the call.
func forcedToolRetryPayload(base *KiroPayload, choice, reply string) *KiroPayload {
	if strings.TrimSpace(reply) == "" {
		reply = "(empty reply)"
	}
	next := buildContinuationPayload(base, reply, 0)
	next.ForcedToolChoice = ""
	tool := ""
	if ctx := next.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext; ctx != nil && len(ctx.Tools) > 0 {
		tool = ctx.Tools[0].ToolSpecification.Name
	}
	next.ConversationState.CurrentMessage.UserInputMessage.Content = forcedToolRetryPrompt(choice, tool)
	return next
}

func forcedToolRetryPrompt(choice, tool string) string {
	if choice == "tool" && tool != "" {
		return fmt.Sprintf("Your previous reply did not call a tool, but this turn requires the tool %q. Call %q now. If a required argument is unknown, pass your best guess or an empty value. Reply with only the tool call.", tool, tool)
	}
	return "Your previous reply did not call a tool, but this turn requires a tool call. Call the most fitting available tool now. Reply with only the tool call."
}
