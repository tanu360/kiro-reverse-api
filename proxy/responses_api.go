package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"

	"github.com/google/uuid"
)

func (h *Handler) handleOpenAIResponses(w http.ResponseWriter, r *http.Request) {
	apiKeyID := apiKeyIDFromContext(r.Context())
	apiKeyValue := apiKeyValueFromContext(r.Context())
	if r.Method != http.MethodPost {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusMethodNotAllowed, "Method Not Allowed")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Failed to read request body")
		h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "Failed to read request body")
		return
	}

	var req OpenAIResponsesRequest
	if err := json.Unmarshal(body, &req); err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Invalid JSON")
		h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "Invalid JSON")
		return
	}

	var previousMessages []OpenAIMessage
	if req.PreviousResponseID != "" {
		state, err := loadResponseState(req.PreviousResponseID)
		if errors.Is(err, sql.ErrNoRows) {
			recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusBadRequest, "previous_response_id not found")
			h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "previous_response_id not found")
			return
		}
		if err != nil {
			recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusInternalServerError, err.Error())
			h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", err.Error())
			return
		}
		previousMessages = state.Messages
	}

	prepared, msg := prepareResponsesRequest(&req, previousMessages)
	if msg != "" {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusBadRequest, msg)
		h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", msg)
		return
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := ParseModelAndThinking(prepared.OpenAIRequest.Model, thinkingCfg.Suffix)
	prepared.OpenAIRequest.Model = actualModel
	thinking = resolveThinkingWithEffort(thinking, prepared.OpenAIRequest.ReasoningEffort)
	estimatedInputTokens := estimateOpenAIRequestInputTokens(&prepared.OpenAIRequest)
	kiroPayload := OpenAIToKiro(&prepared.OpenAIRequest, thinking)
	h.applyReasoningEffort(kiroPayload, prepared.OpenAIRequest.Model, prepared.OpenAIRequest.ReasoningEffort)
	apiKeyReservation, err := reserveApiKeyUsage(apiKeyID, apiKeyValue, tokenBudget(estimatedInputTokens))
	if err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, prepared.OpenAIRequest.Model, 0, 0, 0, false, http.StatusTooManyRequests, err.Error())
		h.sendOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", err.Error())
		return
	}

	if prepared.OpenAIRequest.Stream {
		h.handleOpenAIResponsesStream(r.Context(), w, kiroPayload, prepared, thinking, estimatedInputTokens, apiKeyReservation)
		return
	}
	h.handleOpenAIResponsesNonStream(r.Context(), w, kiroPayload, prepared, thinking, estimatedInputTokens, apiKeyReservation)
}

func (h *Handler) apiGetOpenAIResponse(w http.ResponseWriter, _ *http.Request, id string) {
	state, err := loadResponseState(id)
	if errors.Is(err, sql.ErrNoRows) {
		h.sendOpenAIError(w, http.StatusNotFound, "not_found_error", "response not found")
		return
	}
	if err != nil {
		h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(state.Response)
}

func (h *Handler) apiDeleteOpenAIResponse(w http.ResponseWriter, _ *http.Request, id string) {
	deleted, err := deleteResponseState(id)
	if err != nil {
		h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", err.Error())
		return
	}
	if !deleted {
		h.sendOpenAIError(w, http.StatusNotFound, "not_found_error", "response not found")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":      id,
		"object":  "response.deleted",
		"deleted": true,
	})
}

func (h *Handler) handleOpenAIResponsesNonStream(ctx context.Context, w http.ResponseWriter, payload *KiroPayload, prepared *responsesPreparedRequest, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	model := prepared.OpenAIRequest.Model
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	defer apiKeyReservation.release()

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest && !isUpstreamClientError(lastErr) {
		account := h.pickAccount(payload, model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidTokenContext(ctx, account); err != nil {
				if ctx.Err() != nil {
					recordClientDisconnect(ctx, apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(ctx, totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(ctx, totalAttempts)
				}
				break
			}

			var content string
			var reasoningContent string
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int
			var upstreamStopReason string

			callback := &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if isThinking {
						reasoningContent += text
					} else {
						content += text
					}
				},
				OnToolUse:  func(tu KiroToolUse) { toolUses = append(toolUses, tu) },
				OnComplete: func(inTok, outTok int) { inputTokens = inTok; outputTokens = outTok },
				OnCredits:  func(c float64) { credits = c },
				OnContextUsage: func(pct float64) {
					realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
				},
				OnStopReason: func(reason string) {
					upstreamStopReason = reason
				},
			}

			err := callKiroWithHostedSearch(ctx, account, payload, callback)
			if err != nil {
				if isContextCanceledError(err) {
					recordClientDisconnect(ctx, apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(ctx, totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(ctx, totalAttempts)
				}
				break
			}

			finalContent, extractedReasoning := extractThinkingFromContent(content)
			if thinking && reasoningContent == "" && extractedReasoning != "" {
				reasoningContent = extractedReasoning
			} else if !thinking {
				reasoningContent = ""
			}
			estimatedOutputTokens := estimateOpenAIOutputTokens(finalContent, reasoningContent, toolUses)
			inputTokens, outputTokens = finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			recordFinalRequestForApiKey(ctx, apiKeyReservation, account, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.rememberAccount(payload, account)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)

			response, storedMessages := buildResponsesCompletedObject(prepared, finalContent, reasoningContent, toolUses, inputTokens, outputTokens)
			addResponsesCacheUsage(response, resolveOpenAICacheUsage(h.promptCache, account.ID, payload, inputTokens))
			applyResponsesStopReason(response, upstreamStopReason)
			if prepared.Store {
				if err := saveResponseState(responseStateFromObject(response, storedMessages)); err != nil {
					logger.Warnf("[Responses] Failed to persist response %s: %v", responseIDFromObject(response), err)
				}
			}

			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			json.NewEncoder(w).Encode(response)
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		recordFinalRequestForApiKey(ctx, apiKeyReservation, nil, model, 0, 0, 0, false, http.StatusServiceUnavailable, "No available accounts")
		h.sendOpenAIError(w, http.StatusServiceUnavailable, "server_error", "No available accounts")
		return
	}
	recordFinalRequestForApiKey(ctx, apiKeyReservation, lastAccount, model, 0, 0, 0, false, upstreamFailureStatus(lastErr), lastErr.Error())
	h.sendOpenAIUpstreamError(w, lastErr)
}

func (h *Handler) handleOpenAIResponsesStream(ctx context.Context, w http.ResponseWriter, payload *KiroPayload, prepared *responsesPreparedRequest, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	model := prepared.OpenAIRequest.Model
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	defer apiKeyReservation.release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		recordFinalRequestForApiKey(ctx, apiKeyReservation, nil, model, 0, 0, 0, false, http.StatusInternalServerError, "Streaming not supported")
		h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", "Streaming not supported")
		return
	}

	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest && !isUpstreamClientError(lastErr) {
		account := h.pickAccount(payload, model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidTokenContext(ctx, account); err != nil {
				if ctx.Err() != nil {
					recordClientDisconnect(ctx, apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(ctx, totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(ctx, totalAttempts)
				}
				break
			}

			var contentBuilder strings.Builder
			var reasoningBuilder strings.Builder
			var splitter thinkingTagSplitter
			var thinkingSource thinkingStreamSource
			sawVisibleText := false
			sawReasoningText := false
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int
			var upstreamStopReason string
			responseID := "resp_" + uuid.NewString()
			createdAt := time.Now().Unix()
			started := false
			messageItemID := "msg_" + uuid.NewString()
			messageAdded := false
			messageOutputIndex := -1
			reasoningItemID := "rs_" + uuid.NewString()
			reasoningAdded := false
			reasoningOutputIndex := -1
			nextOutputIndex := 0
			var outputItems []map[string]interface{}
			reserveOutputItem := func(index int, item map[string]interface{}) {
				for len(outputItems) <= index {
					outputItems = append(outputItems, nil)
				}
				outputItems[index] = item
			}

			ensureStarted := func() {
				if started {
					return
				}
				sendResponsesSSE(w, flusher, "response.created", map[string]interface{}{
					"type":     "response.created",
					"response": buildResponsesBaseObject(responseID, createdAt, "in_progress", prepared, nil, ""),
				})
				started = true
			}
			//! The reasoning item must be announced before its deltas; clients ignore
			//! summary deltas for an item they never saw in response.output_item.added.
			ensureReasoningAdded := func() {
				ensureStarted()
				if reasoningAdded {
					return
				}
				reasoningOutputIndex = nextOutputIndex
				nextOutputIndex++
				reserveOutputItem(reasoningOutputIndex, buildResponsesReasoningOutputItemWithID(reasoningItemID, ""))
				sendResponsesSSE(w, flusher, "response.output_item.added", map[string]interface{}{
					"type":         "response.output_item.added",
					"output_index": reasoningOutputIndex,
					"item": map[string]interface{}{
						"id":      reasoningItemID,
						"type":    "reasoning",
						"status":  "in_progress",
						"summary": []interface{}{},
						"content": []interface{}{},
					},
				})
				sendResponsesSSE(w, flusher, "response.reasoning_summary_part.added", map[string]interface{}{
					"type":          "response.reasoning_summary_part.added",
					"item_id":       reasoningItemID,
					"output_index":  reasoningOutputIndex,
					"summary_index": 0,
					"part":          map[string]interface{}{"type": "summary_text", "text": ""},
				})
				reasoningAdded = true
			}
			finishReasoning := func(reasoning string) {
				if !reasoningAdded {
					return
				}
				reserveOutputItem(reasoningOutputIndex, buildResponsesReasoningOutputItemWithID(reasoningItemID, reasoning))
				sendResponsesSSE(w, flusher, "response.reasoning_summary_text.done", map[string]interface{}{
					"type":          "response.reasoning_summary_text.done",
					"item_id":       reasoningItemID,
					"output_index":  reasoningOutputIndex,
					"summary_index": 0,
					"text":          reasoning,
				})
				sendResponsesSSE(w, flusher, "response.reasoning_summary_part.done", map[string]interface{}{
					"type":          "response.reasoning_summary_part.done",
					"item_id":       reasoningItemID,
					"output_index":  reasoningOutputIndex,
					"summary_index": 0,
					"part":          map[string]interface{}{"type": "summary_text", "text": reasoning},
				})
				sendResponsesSSE(w, flusher, "response.output_item.done", map[string]interface{}{
					"type":         "response.output_item.done",
					"output_index": reasoningOutputIndex,
					"item":         outputItems[reasoningOutputIndex],
				})
			}
			ensureMessageAdded := func() {
				ensureStarted()
				if messageAdded {
					return
				}
				messageOutputIndex = nextOutputIndex
				nextOutputIndex++
				reserveOutputItem(messageOutputIndex, buildResponsesMessageOutputItem(messageItemID, ""))
				sendResponsesSSE(w, flusher, "response.output_item.added", map[string]interface{}{
					"type":         "response.output_item.added",
					"output_index": messageOutputIndex,
					"item": map[string]interface{}{
						"id":      messageItemID,
						"type":    "message",
						"status":  "in_progress",
						"role":    "assistant",
						"content": []interface{}{},
					},
				})
				sendResponsesSSE(w, flusher, "response.content_part.added", map[string]interface{}{
					"type":          "response.content_part.added",
					"item_id":       messageItemID,
					"output_index":  messageOutputIndex,
					"content_index": 0,
					"part":          map[string]interface{}{"type": "output_text", "text": "", "annotations": []interface{}{}},
				})
				messageAdded = true
			}

			//! Trim the newline the model leaves after <thinking> so clients do not render a
			//! blank line above every reasoning block. Builder and deltas stay in sync.
			emitReasoningDelta := func(text string) {
				if !sawReasoningText {
					text = strings.TrimLeft(text, " \t\r\n")
					if text == "" {
						return
					}
					sawReasoningText = true
				}
				reasoningBuilder.WriteString(text)
				ensureReasoningAdded()
				sendResponsesSSE(w, flusher, "response.reasoning_summary_text.delta", map[string]interface{}{
					"type":          "response.reasoning_summary_text.delta",
					"item_id":       reasoningItemID,
					"output_index":  reasoningOutputIndex,
					"summary_index": 0,
					"delta":         text,
				})
			}
			//! response.output_text.done is authoritative for clients, so the final text must
			//! equal the concatenated deltas. Leading whitespace left behind by a stripped
			//! thinking block is dropped here, before it is ever streamed or buffered.
			emitTextDelta := func(text string) {
				if !sawVisibleText {
					text = strings.TrimLeft(text, " \t\r\n")
					if text == "" {
						return
					}
					sawVisibleText = true
				}
				contentBuilder.WriteString(text)
				ensureMessageAdded()
				sendResponsesSSE(w, flusher, "response.output_text.delta", map[string]interface{}{
					"type":          "response.output_text.delta",
					"item_id":       messageItemID,
					"output_index":  messageOutputIndex,
					"content_index": 0,
					"delta":         text,
				})
			}
			//! Thinking recovered from inline tags is dropped when the caller did not ask for
			//! it, and yields to a native reasoning stream if the upstream provides both.
			emitTagThinking := func(text string) {
				if !thinking || !allowTagSource(&thinkingSource) {
					return
				}
				emitReasoningDelta(text)
			}

			callback := &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if text == "" {
						return
					}
					if isThinking {
						if !thinking || !allowReasoningSource(&thinkingSource) {
							return
						}
						emitReasoningDelta(text)
						return
					}
					splitter.Push(text, emitTextDelta, emitTagThinking)
				},
				OnToolUse: func(tu KiroToolUse) {
					ensureStarted()
					toolUses = append(toolUses, tu)
					item := buildPreparedResponsesToolOutputItem(prepared, tu)
					outputIndex := nextOutputIndex
					nextOutputIndex++
					reserveOutputItem(outputIndex, item)
					added := make(map[string]interface{}, len(item))
					for key, value := range item {
						added[key] = value
					}
					added["status"] = "in_progress"
					field, event := "arguments", "response.function_call_arguments"
					if item["type"] == "custom_tool_call" {
						field, event = "input", "response.custom_tool_call_input"
					}
					added[field] = ""
					sendResponsesSSE(w, flusher, "response.output_item.added", map[string]interface{}{
						"type":         "response.output_item.added",
						"output_index": outputIndex,
						"item":         added,
					})
					sendResponsesSSE(w, flusher, event+".delta", map[string]interface{}{"type": event + ".delta", "item_id": item["id"], "output_index": outputIndex, "delta": item[field]})
					sendResponsesSSE(w, flusher, event+".done", map[string]interface{}{"type": event + ".done", "item_id": item["id"], "output_index": outputIndex, field: item[field]})
					sendResponsesSSE(w, flusher, "response.output_item.done", map[string]interface{}{
						"type":         "response.output_item.done",
						"output_index": outputIndex,
						"item":         item,
					})
				},
				OnComplete: func(inTok, outTok int) { inputTokens = inTok; outputTokens = outTok },
				OnCredits:  func(c float64) { credits = c },
				OnContextUsage: func(pct float64) {
					realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
				},
				OnStopReason: func(reason string) {
					upstreamStopReason = reason
				},
			}

			err := callKiroWithHostedSearch(ctx, account, payload, callback)
			if err != nil {
				if isContextCanceledError(err) {
					recordClientDisconnect(ctx, apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if !started {
					if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
						retryPlan.waitBeforeRetry(ctx, totalAttempts)
						continue
					}
					if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
						retryPlan.waitBeforeRetry(ctx, totalAttempts)
					}
					break
				}
				sendResponsesSSE(w, flusher, "response.failed", map[string]interface{}{
					"type": "response.failed",
					"response": map[string]interface{}{
						"id":     responseID,
						"object": "response",
						"status": "failed",
						"error":  map[string]string{"message": err.Error()},
					},
				})
				recordFinalRequestForApiKey(ctx, apiKeyReservation, account, model, 0, 0, 0, false, http.StatusInternalServerError, err.Error())
				return
			}

			ensureStarted()
			//! Release the tag buffer before reading the builders; the splitter has already
			//! separated thinking from answer text, so no post-hoc extraction is needed and
			//! finalContent stays byte-identical to what was streamed.
			splitter.Flush(emitTextDelta, emitTagThinking)
			finalContent := contentBuilder.String()
			reasoningContent := reasoningBuilder.String()
			if !thinking {
				reasoningContent = ""
			}
			estimatedOutputTokens := estimateOpenAIOutputTokens(finalContent, reasoningContent, toolUses)
			inputTokens, outputTokens = finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			recordFinalRequestForApiKey(ctx, apiKeyReservation, account, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.rememberAccount(payload, account)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)

			//! Reasoning recovered from inline <thinking> tags never streamed, so announce
			//! it now and replay it as one delta before closing the item.
			if reasoningContent != "" && !reasoningAdded {
				ensureReasoningAdded()
				sendResponsesSSE(w, flusher, "response.reasoning_summary_text.delta", map[string]interface{}{
					"type":          "response.reasoning_summary_text.delta",
					"item_id":       reasoningItemID,
					"output_index":  reasoningOutputIndex,
					"summary_index": 0,
					"delta":         reasoningContent,
				})
			}
			finishReasoning(reasoningContent)

			if messageAdded {
				reserveOutputItem(messageOutputIndex, buildResponsesMessageOutputItem(messageItemID, finalContent))
				sendResponsesSSE(w, flusher, "response.output_text.done", map[string]interface{}{
					"type":          "response.output_text.done",
					"item_id":       messageItemID,
					"output_index":  messageOutputIndex,
					"content_index": 0,
					"text":          finalContent,
				})
				sendResponsesSSE(w, flusher, "response.content_part.done", map[string]interface{}{
					"type":          "response.content_part.done",
					"item_id":       messageItemID,
					"output_index":  messageOutputIndex,
					"content_index": 0,
					"part":          map[string]interface{}{"type": "output_text", "text": finalContent, "annotations": []interface{}{}},
				})
				sendResponsesSSE(w, flusher, "response.output_item.done", map[string]interface{}{
					"type":         "response.output_item.done",
					"output_index": messageOutputIndex,
					"item":         outputItems[messageOutputIndex],
				})
			}
			if !messageAdded && len(toolUses) == 0 {
				reserveOutputItem(nextOutputIndex, buildResponsesMessageOutputItem(messageItemID, finalContent))
				nextOutputIndex++
			}
			response, storedMessages := buildResponsesCompletedObjectWithOutput(responseID, createdAt, prepared, outputItems, finalContent, toolUses, inputTokens, outputTokens)
			addResponsesCacheUsage(response, resolveOpenAICacheUsage(h.promptCache, account.ID, payload, inputTokens))
			terminalEvent := applyResponsesStopReason(response, upstreamStopReason)
			sendResponsesSSE(w, flusher, terminalEvent, map[string]interface{}{
				"type":     terminalEvent,
				"response": response,
			})
			if prepared.Store {
				if err := saveResponseState(responseStateFromObject(response, storedMessages)); err != nil {
					logger.Warnf("[Responses] Failed to persist response %s: %v", responseID, err)
				}
			}
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		recordFinalRequestForApiKey(ctx, apiKeyReservation, nil, model, 0, 0, 0, false, http.StatusServiceUnavailable, "No available accounts")
		h.sendOpenAIError(w, http.StatusServiceUnavailable, "server_error", "No available accounts")
		return
	}
	recordFinalRequestForApiKey(ctx, apiKeyReservation, lastAccount, model, 0, 0, 0, false, upstreamFailureStatus(lastErr), lastErr.Error())
	h.sendOpenAIUpstreamError(w, lastErr)
}

func sendResponsesSSE(w http.ResponseWriter, flusher http.Flusher, event string, data interface{}) {
	b, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\n", event)
	fmt.Fprintf(w, "data: %s\n\n", string(b))
	flusher.Flush()
}

func buildResponsesCompletedObject(prepared *responsesPreparedRequest, content, reasoning string, toolUses []KiroToolUse, inputTokens, outputTokens int) (map[string]interface{}, []OpenAIMessage) {
	return buildResponsesCompletedObjectWithID("resp_"+uuid.NewString(), time.Now().Unix(), prepared, content, reasoning, toolUses, inputTokens, outputTokens)
}

func buildResponsesCompletedObjectWithID(id string, createdAt int64, prepared *responsesPreparedRequest, content, reasoning string, toolUses []KiroToolUse, inputTokens, outputTokens int) (map[string]interface{}, []OpenAIMessage) {
	output := buildResponsesOutput(content, reasoning, toolUses)
	for i, tu := range toolUses {
		output[len(output)-len(toolUses)+i] = buildPreparedResponsesToolOutputItem(prepared, tu)
	}
	return buildResponsesCompletedObjectWithOutput(id, createdAt, prepared, output, content, toolUses, inputTokens, outputTokens)
}

func buildResponsesCompletedObjectWithOutput(id string, createdAt int64, prepared *responsesPreparedRequest, output []map[string]interface{}, outputText string, toolUses []KiroToolUse, inputTokens, outputTokens int) (map[string]interface{}, []OpenAIMessage) {
	response := buildResponsesBaseObject(id, createdAt, "completed", prepared, output, outputText)
	response["usage"] = map[string]int{
		"input_tokens":  inputTokens,
		"output_tokens": outputTokens,
		"total_tokens":  inputTokens + outputTokens,
	}

	storedMessages := append([]OpenAIMessage(nil), prepared.StoredMessages...)
	storedMessages = append(storedMessages, responsesAssistantMessage(outputText, toolUses))
	return response, storedMessages
}

func applyResponsesStopReason(response map[string]interface{}, stopReason string) (terminalEvent string) {
	//! A length or content-filter stop is reported as "incomplete" so clients do not treat a cut-off answer as whole.
	status, incompleteReason := mapResponsesCompletion(stopReason)
	response["status"] = status
	if status == "incomplete" {
		response["incomplete_details"] = map[string]string{"reason": incompleteReason}
		return "response.incomplete"
	}
	response["incomplete_details"] = nil
	return "response.completed"
}

func buildResponsesBaseObject(id string, createdAt int64, status string, prepared *responsesPreparedRequest, output []map[string]interface{}, outputText string) map[string]interface{} {
	if output == nil {
		output = []map[string]interface{}{}
	}
	response := map[string]interface{}{
		"id":                   id,
		"object":               "response",
		"created_at":           createdAt,
		"status":               status,
		"model":                prepared.OpenAIRequest.Model,
		"previous_response_id": nil,
		"output":               output,
		"output_text":          outputText,
	}
	if prepared.PreviousResponse != "" {
		response["previous_response_id"] = prepared.PreviousResponse
	}
	if len(prepared.Metadata) > 0 {
		response["metadata"] = prepared.Metadata
	}
	return response
}

func buildResponsesOutput(content, reasoning string, toolUses []KiroToolUse) []map[string]interface{} {
	output := make([]map[string]interface{}, 0, 2+len(toolUses))
	//! Reasoning precedes the message so clients render thinking before the answer.
	if reasoning != "" {
		output = append(output, buildResponsesReasoningOutputItem(reasoning))
	}
	if content != "" || len(toolUses) == 0 {
		output = append(output, buildResponsesMessageOutputItem("msg_"+uuid.NewString(), content))
	}
	for _, tu := range toolUses {
		output = append(output, buildResponsesToolOutputItem(tu))
	}
	return output
}

func buildResponsesMessageOutputItem(id, content string) map[string]interface{} {
	return map[string]interface{}{
		"id":     id,
		"type":   "message",
		"status": "completed",
		"role":   "assistant",
		"content": []map[string]interface{}{{
			"type":        "output_text",
			"text":        content,
			"annotations": []interface{}{},
		}},
	}
}

func buildResponsesReasoningOutputItem(reasoning string) map[string]interface{} {
	return buildResponsesReasoningOutputItemWithID("rs_"+uuid.NewString(), reasoning)
}

//! Codex decodes reasoning items strictly: "summary" holds summary_text parts and
//! "content" holds reasoning_text parts. A bare string or an empty summary leaves the
//! client with nothing to render, so the thinking block vanishes after the stream ends.
func buildResponsesReasoningOutputItemWithID(id, reasoning string) map[string]interface{} {
	summary := []interface{}{}
	content := []interface{}{}
	if reasoning != "" {
		summary = append(summary, map[string]interface{}{"type": "summary_text", "text": reasoning})
		content = append(content, map[string]interface{}{"type": "reasoning_text", "text": reasoning})
	}
	return map[string]interface{}{
		"id":      id,
		"type":    "reasoning",
		"status":  "completed",
		"summary": summary,
		"content": content,
	}
}

func buildResponsesToolOutputItem(tu KiroToolUse) map[string]interface{} {
	args, _ := json.Marshal(tu.Input)
	return map[string]interface{}{
		"id":        tu.ToolUseID,
		"type":      "function_call",
		"status":    "completed",
		"call_id":   tu.ToolUseID,
		"name":      tu.Name,
		"arguments": string(args),
	}
}

func responsesAssistantMessage(content string, toolUses []KiroToolUse) OpenAIMessage {
	msg := OpenAIMessage{Role: "assistant", Content: content}
	if len(toolUses) == 0 {
		return msg
	}
	if content == "" {
		msg.Content = nil
	}
	msg.ToolCalls = make([]ToolCall, len(toolUses))
	for i, tu := range toolUses {
		args, _ := json.Marshal(tu.Input)
		msg.ToolCalls[i] = ToolCall{ID: tu.ToolUseID, Type: "function"}
		msg.ToolCalls[i].Function.Name = tu.Name
		msg.ToolCalls[i].Function.Arguments = string(args)
	}
	return msg
}

func responseStateFromObject(response map[string]interface{}, messages []OpenAIMessage) responseState {
	createdAt, _ := response["created_at"].(int64)
	if createdAt == 0 {
		if v, ok := response["created_at"].(float64); ok {
			createdAt = int64(v)
		}
	}
	previous, _ := response["previous_response_id"].(string)
	model, _ := response["model"].(string)
	status, _ := response["status"].(string)
	metadata, _ := response["metadata"].(map[string]interface{})
	return responseState{
		ID:                 responseIDFromObject(response),
		CreatedAt:          createdAt,
		PreviousResponseID: previous,
		Model:              model,
		Status:             status,
		Metadata:           metadata,
		Response:           response,
		Messages:           messages,
	}
}

func responseIDFromObject(response map[string]interface{}) string {
	id, _ := response["id"].(string)
	return id
}
