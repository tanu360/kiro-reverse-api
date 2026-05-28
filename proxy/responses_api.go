package proxy

import (
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
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "Failed to read request body")
		return
	}

	var req OpenAIResponsesRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "Invalid JSON")
		return
	}

	var previousMessages []OpenAIMessage
	if req.PreviousResponseID != "" {
		state, err := loadResponseState(req.PreviousResponseID)
		if errors.Is(err, sql.ErrNoRows) {
			h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "previous_response_id not found")
			return
		}
		if err != nil {
			h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", err.Error())
			return
		}
		previousMessages = state.Messages
	}

	prepared, msg := prepareResponsesRequest(&req, previousMessages)
	if msg != "" {
		h.sendOpenAIError(w, http.StatusBadRequest, "invalid_request_error", msg)
		return
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := ParseModelAndThinking(prepared.OpenAIRequest.Model, thinkingCfg.Suffix)
	prepared.OpenAIRequest.Model = actualModel
	estimatedInputTokens := estimateOpenAIRequestInputTokens(&prepared.OpenAIRequest)
	kiroPayload := OpenAIToKiro(&prepared.OpenAIRequest, thinking)
	apiKeyReservation, err := reserveApiKeyUsage(apiKeyIDFromContext(r.Context()), apiKeyValueFromContext(r.Context()), tokenBudget(estimatedInputTokens, prepared.OpenAIRequest.MaxTokens))
	if err != nil {
		h.sendOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", err.Error())
		return
	}

	if prepared.OpenAIRequest.Stream {
		h.handleOpenAIResponsesStream(w, kiroPayload, prepared, thinking, estimatedInputTokens, apiKeyReservation)
		return
	}
	h.handleOpenAIResponsesNonStream(w, kiroPayload, prepared, thinking, estimatedInputTokens, apiKeyReservation)
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

func (h *Handler) handleOpenAIResponsesNonStream(w http.ResponseWriter, payload *KiroPayload, prepared *responsesPreparedRequest, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	model := prepared.OpenAIRequest.Model
	excluded := make(map[string]bool)
	var lastErr error
	defer apiKeyReservation.release()

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest {
		account := h.pool.GetNextForModelExcluding(model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidToken(account); err != nil {
				lastErr = err
				h.handleAccountFailure(account, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}

			var content string
			var reasoningContent string
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int

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
			}

			err := CallKiroAPI(account, payload, callback)
			if err != nil {
				lastErr = err
				h.handleAccountFailure(account, err)
				getObserveStore().RecordFailure(account.ID, model)
				getObserveStore().RecordError(account.ID, account.Email, model, 0, err.Error())
				getObserveStore().RecordRequestForApiKey(apiKeyReservation, account.ID, account.Email, model, 0, 0, 0, false, 0, err.Error())
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}

			finalContent, extractedReasoning := extractThinkingFromContent(content)
			if thinking && reasoningContent == "" && extractedReasoning != "" {
				reasoningContent = extractedReasoning
			} else if !thinking {
				reasoningContent = ""
			}
			if realInputTokens > 0 {
				inputTokens = realInputTokens
			} else if inputTokens <= 0 {
				inputTokens = estimatedInputTokens
			}
			outputTokens = estimateOpenAIOutputTokens(finalContent, reasoningContent, toolUses)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			getObserveStore().RecordRequestForApiKey(apiKeyReservation, account.ID, account.Email, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)

			response, storedMessages := buildResponsesCompletedObject(prepared, finalContent, reasoningContent, toolUses, inputTokens, outputTokens)
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
		h.sendOpenAIError(w, http.StatusServiceUnavailable, "server_error", "No available accounts")
		return
	}
	h.recordFailure()
	h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", lastErr.Error())
}

func (h *Handler) handleOpenAIResponsesStream(w http.ResponseWriter, payload *KiroPayload, prepared *responsesPreparedRequest, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	model := prepared.OpenAIRequest.Model
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	defer apiKeyReservation.release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", "Streaming not supported")
		return
	}

	excluded := make(map[string]bool)
	var lastErr error
	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest {
		account := h.pool.GetNextForModelExcluding(model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidToken(account); err != nil {
				lastErr = err
				h.handleAccountFailure(account, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}

			var contentBuilder strings.Builder
			var reasoningBuilder strings.Builder
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int
			responseID := "resp_" + uuid.NewString()
			createdAt := time.Now().Unix()
			started := false
			messageItemID := "msg_" + uuid.NewString()
			messageAdded := false
			messageOutputIndex := -1
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

			callback := &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if text == "" {
						return
					}
					if isThinking {
						reasoningBuilder.WriteString(text)
						return
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
				},
				OnToolUse: func(tu KiroToolUse) {
					ensureStarted()
					toolUses = append(toolUses, tu)
					item := buildResponsesToolOutputItem(tu)
					outputIndex := nextOutputIndex
					nextOutputIndex++
					reserveOutputItem(outputIndex, item)
					sendResponsesSSE(w, flusher, "response.output_item.added", map[string]interface{}{
						"type":         "response.output_item.added",
						"output_index": outputIndex,
						"item":         item,
					})
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
			}

			err := CallKiroAPI(account, payload, callback)
			if err != nil {
				lastErr = err
				h.handleAccountFailure(account, err)
				getObserveStore().RecordFailure(account.ID, model)
				getObserveStore().RecordError(account.ID, account.Email, model, 0, err.Error())
				getObserveStore().RecordRequestForApiKey(apiKeyReservation, account.ID, account.Email, model, 0, 0, 0, false, 0, err.Error())
				if !started {
					if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
						retryPlan.waitBeforeRetry(totalAttempts)
						continue
					}
					if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
						retryPlan.waitBeforeRetry(totalAttempts)
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
				h.recordFailure()
				return
			}

			ensureStarted()
			finalContent, extractedReasoning := extractThinkingFromContent(contentBuilder.String())
			reasoningContent := reasoningBuilder.String()
			if thinking && reasoningContent == "" && extractedReasoning != "" {
				reasoningContent = extractedReasoning
			} else if !thinking {
				reasoningContent = ""
			}
			if realInputTokens > 0 {
				inputTokens = realInputTokens
			} else if inputTokens <= 0 {
				inputTokens = estimatedInputTokens
			}
			outputTokens = estimateOpenAIOutputTokens(finalContent, reasoningContent, toolUses)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			getObserveStore().RecordRequestForApiKey(apiKeyReservation, account.ID, account.Email, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)

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
			if len(outputItems) == 0 && len(toolUses) == 0 {
				reserveOutputItem(nextOutputIndex, buildResponsesMessageOutputItem(messageItemID, finalContent))
				nextOutputIndex++
			}
			if reasoningContent != "" {
				reserveOutputItem(nextOutputIndex, buildResponsesReasoningOutputItem(reasoningContent))
				nextOutputIndex++
			}
			response, storedMessages := buildResponsesCompletedObjectWithOutput(responseID, createdAt, prepared, outputItems, finalContent, toolUses, inputTokens, outputTokens)
			sendResponsesSSE(w, flusher, "response.completed", map[string]interface{}{
				"type":     "response.completed",
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
		h.sendOpenAIError(w, http.StatusServiceUnavailable, "server_error", "No available accounts")
		return
	}
	h.recordFailure()
	h.sendOpenAIError(w, http.StatusInternalServerError, "server_error", lastErr.Error())
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
	if content != "" || len(toolUses) == 0 {
		output = append(output, buildResponsesMessageOutputItem("msg_"+uuid.NewString(), content))
	}
	if reasoning != "" {
		output = append(output, buildResponsesReasoningOutputItem(reasoning))
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
	return map[string]interface{}{
		"id":      "rs_" + uuid.NewString(),
		"type":    "reasoning",
		"summary": []interface{}{},
		"content": reasoning,
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
