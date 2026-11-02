package proxy

import (
	"context"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"strings"
)

//! Kiro caps one answer near 8192 output tokens (Kiro-Go #127). With the opt-in
//! auto-continue setting, a turn that stops on the output cap without tool calls is
//! resumed by follow-up requests, and their text streams into the same client message.
//!
//! Thinking: a hop that ends inside an inline <thinking> block, or produced no answer
//! text, is not continued; resuming mid-thought would splice reasoning into the answer.
//! Continuation hops drop all reasoning (reasoning events and inline <thinking> blocks),
//! so the client sees the first hop's thinking followed by one growing answer.

const autoContinuePrompt = "Your previous response was cut off by the output limit. Continue exactly where it stopped, even mid-sentence or mid-code block. Do not repeat any earlier text and do not add a preamble or summary."

type kiroCallFunc func(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback) error

// callKiroAutoContinue runs call and, when the setting is on, continues answers cut off at the output cap.
func callKiroAutoContinue(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback, call kiroCallFunc) error {
	if callback == nil || payload == nil || !config.GetAutoContinue() {
		return call(ctx, account, payload, callback)
	}
	return runAutoContinue(ctx, account, payload, callback, call, config.GetAutoContinueMax())
}

func runAutoContinue(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback, call kiroCallFunc, maxContinuations int) error {
	var answer strings.Builder
	totalIn, totalOut := 0, 0
	totalCredits := 0.0
	totalCacheRead, totalCacheWrite := 0, 0
	stopReason := ""
	next := payload
	for hop := 0; ; hop++ {
		state := &continuationHop{continuation: hop > 0, downstream: callback}
		if err := call(ctx, account, next, state.callback()); err != nil {
			//! The first hop's errors belong to the handler's retry logic, and a gone client ends everything.
			if hop == 0 || isContextCanceledError(err) || ctx.Err() != nil {
				return err
			}
			//! The client already holds the earlier hops; end the message there, still marked as cut off.
			state.flush()
			logger.Warnf("[AutoContinue] Continuation %d failed, ending with the partial answer: %v", hop, err)
			break
		}
		openThinking := state.flush()
		answer.WriteString(state.answer.String())
		totalIn += state.inputTokens
		totalOut += state.outputTokens
		totalCredits += state.credits
		totalCacheRead += state.cacheRead
		totalCacheWrite += state.cacheWrite
		stopReason = state.stopReason

		if hop >= maxContinuations || !state.cutAtOutputCap(openThinking) {
			break
		}
		budget, ok := remainingOutputBudget(payload, totalOut, answer.String())
		if !ok {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		logger.Infof("[AutoContinue] Answer hit the output cap, requesting continuation %d/%d", hop+1, maxContinuations)
		next = buildContinuationPayload(payload, answer.String(), budget)
	}

	if callback.OnStopReason != nil {
		callback.OnStopReason(stopReason)
	}
	if callback.OnCredits != nil && totalCredits > 0 {
		callback.OnCredits(totalCredits)
	}
	//! Input is summed across hops, so cache counts must be too, or cache exceeds nothing it belongs to.
	if callback.OnCacheUsage != nil && totalCacheRead+totalCacheWrite > 0 {
		callback.OnCacheUsage(totalCacheRead, totalCacheWrite)
	}
	if callback.OnComplete != nil {
		callback.OnComplete(totalIn, totalOut)
	}
	return nil
}

type continuationHop struct {
	continuation bool
	downstream   *KiroStreamCallback
	// splitter tracks inline thinking; on continuation hops it also strips it from the forwarded text.
	splitter     thinkingTagSplitter
	answer       strings.Builder
	toolCount    int
	stopReason   string
	inputTokens  int
	outputTokens int
	credits      float64
	cacheRead    int
	cacheWrite   int
}

func (h *continuationHop) callback() *KiroStreamCallback {
	cb := *h.downstream
	cb.OnText = func(text string, isThinking bool) {
		if isThinking {
			if !h.continuation {
				h.forward(text, true)
			}
			return
		}
		if h.continuation {
			h.splitter.Push(text, h.forwardAnswer, nil)
			return
		}
		h.splitter.Push(text, h.recordAnswer, nil)
		h.forward(text, false)
	}
	cb.OnToolUse = func(toolUse KiroToolUse) {
		h.toolCount++
		if h.continuation {
			//! Text held for a possible tag must reach the client before the tool block.
			h.flush()
		}
		if h.downstream.OnToolUse != nil {
			h.downstream.OnToolUse(toolUse)
		}
	}
	cb.OnStopReason = func(reason string) { h.stopReason = reason }
	cb.OnCredits = func(credits float64) { h.credits += credits }
	cb.OnCacheUsage = func(read, write int) { h.cacheRead, h.cacheWrite = read, write }
	cb.OnComplete = func(inputTokens, outputTokens int) {
		h.inputTokens, h.outputTokens = inputTokens, outputTokens
	}
	return &cb
}

func (h *continuationHop) forward(text string, isThinking bool) {
	if h.downstream.OnText != nil {
		h.downstream.OnText(text, isThinking)
	}
}

func (h *continuationHop) recordAnswer(text string) {
	h.answer.WriteString(text)
}

func (h *continuationHop) forwardAnswer(text string) {
	h.answer.WriteString(text)
	h.forward(text, false)
}

// flush releases held text and reports whether the hop ended inside a thinking block.
func (h *continuationHop) flush() bool {
	openThinking := h.splitter.inBlock
	if h.continuation {
		h.splitter.Flush(h.forwardAnswer, nil)
	} else {
		h.splitter.Flush(h.recordAnswer, nil)
	}
	return openThinking
}

func (h *continuationHop) cutAtOutputCap(openThinking bool) bool {
	return h.toolCount == 0 &&
		!openThinking &&
		(isOutputCapStopReason(h.stopReason) || h.reachedKiroCapWithoutStopReason()) &&
		strings.TrimSpace(h.answer.String()) != ""
}

// kiroOutputCapInferTokens is how close to Kiro's ~8192-token answer cap a hop must
// get before a missing stop reason is read as the cap.
const kiroOutputCapInferTokens = 8192 * 95 / 100

func (h *continuationHop) reachedKiroCapWithoutStopReason() bool {
	//! IdC / Enterprise accounts never send a stopReason, so the cap can only be inferred
	//! from the hop's own output size. outputTokens may be a local estimate, hence the margin.
	return strings.TrimSpace(h.stopReason) == "" && h.outputTokens >= kiroOutputCapInferTokens
}

// isOutputCapStopReason accepts every spelling mapClaudeStopReason reads as max_tokens.
func isOutputCapStopReason(reason string) bool {
	return mapClaudeStopReason(reason, 0) == "max_tokens"
}

// remainingOutputBudget keeps continuations inside the client's own max_tokens.
func remainingOutputBudget(payload *KiroPayload, usedOutputTokens int, answer string) (int, bool) {
	if payload.InferenceConfig == nil || payload.InferenceConfig.MaxTokens <= 0 {
		return 0, true
	}
	if usedOutputTokens <= 0 {
		usedOutputTokens = estimateApproxTokens(answer)
	}
	remaining := payload.InferenceConfig.MaxTokens - usedOutputTokens
	return remaining, remaining > 0
}

// buildContinuationPayload replays the original turn, then the answer so far as the
// assistant's turn, then asks for the rest. base is never modified.
func buildContinuationPayload(base *KiroPayload, answer string, budget int) *KiroPayload {
	next := *base
	current := base.ConversationState.CurrentMessage.UserInputMessage
	historyUser := current
	if current.UserInputMessageContext != nil {
		ctxCopy := *current.UserInputMessageContext
		historyUser.UserInputMessageContext = &ctxCopy
	}
	history := make([]KiroHistoryMessage, 0, len(base.ConversationState.History)+2)
	for _, message := range base.ConversationState.History {
		if message.AssistantResponseMessage != nil {
			copied := *message.AssistantResponseMessage
			message.AssistantResponseMessage = &copied
		}
		if message.UserInputMessage != nil {
			copied := *message.UserInputMessage
			if copied.UserInputMessageContext != nil {
				ctxCopy := *copied.UserInputMessageContext
				copied.UserInputMessageContext = &ctxCopy
			}
			message.UserInputMessage = &copied
		}
		history = append(history, message)
	}
	history = append(history,
		KiroHistoryMessage{UserInputMessage: &historyUser},
		KiroHistoryMessage{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: answer}},
	)
	var declared map[string]string
	if current.UserInputMessageContext != nil {
		declared = structuredToolHistoryNames(current.UserInputMessageContext.Tools, base.ToolNameMap)
	}
	//! The continuation still declares the request's tools, so structured pairs stay structured.
	next.ConversationState.History = sanitizeKiroHistoryForTools(history, nil, declared)
	next.ConversationState.CurrentMessage.UserInputMessage = KiroUserInputMessage{
		Content: autoContinuePrompt,
		ModelID: current.ModelID,
		Origin:  current.Origin,
	}
	if current.UserInputMessageContext != nil && len(current.UserInputMessageContext.Tools) > 0 {
		next.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext = &UserInputMessageContext{
			Tools: current.UserInputMessageContext.Tools,
		}
	}
	if budget > 0 && base.InferenceConfig != nil {
		inference := *base.InferenceConfig
		inference.MaxTokens = budget
		next.InferenceConfig = &inference
	}
	return &next
}
