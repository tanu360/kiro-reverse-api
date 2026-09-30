package proxy

import "strings"

func resolveAdapterThinking(current bool, thinking *ClaudeThinkingConfig, effort string) bool {
	if thinking != nil {
		if thinking.Type == "disabled" {
			return false
		}
		current = current || isClaudeThinkingRequested(thinking)
	}
	return resolveThinkingWithEffort(current, effort)
}

func (h *Handler) adapterModelSchema(model string) map[string]interface{} {
	h.modelsCacheMu.RLock()
	defer h.modelsCacheMu.RUnlock()
	for _, entry := range h.cachedModels {
		if strings.EqualFold(entry.ModelId, model) {
			return entry.AdditionalModelRequestFieldsSchema
		}
	}
	return nil
}

// Match native model schemas rather than sending Claude-specific fields to
// every model. Explicit native fields/effort remain intact; enabled budgets
// use the same effort ranges as the reference manager (Kiro has no budget knob).
func (h *Handler) applyAdapterThinking(payload *KiroPayload, model string, thinking *ClaudeThinkingConfig, effort string) {
	schema := h.adapterModelSchema(model)
	properties, _ := schema["properties"].(map[string]interface{})
	// The first request can precede the background model listing. Preserve
	// requested native controls during a cold cache, as the reference adapter
	// does, instead of silently reverting to a fixed legacy prompt budget.
	if len(properties) == 0 {
		if strings.HasPrefix(strings.ToLower(model), "gpt-") {
			properties = map[string]interface{}{"reasoning": map[string]interface{}{}}
		} else {
			properties = map[string]interface{}{"thinking": map[string]interface{}{}, "output_config": map[string]interface{}{}}
		}
	}
	fields := payload.AdditionalModelRequestFields
	if fields == nil {
		fields = map[string]interface{}{}
	}
	output, _ := fields["output_config"].(map[string]interface{})
	if effort == "" && output != nil {
		effort = firstString(output["effort"])
	}
	wanted := isClaudeThinkingRequested(thinking) || (effort != "" && effort != "none" && effort != "minimal")
	if thinking != nil && thinking.Type == "disabled" {
		wanted = false
	}
	native := false
	if _, ok := properties["reasoning"]; ok {
		if wanted || (thinking != nil && thinking.Type == "disabled") || effort == "none" || effort == "minimal" {
			reasoning, _ := fields["reasoning"].(map[string]interface{})
			if reasoning == nil {
				reasoning = map[string]interface{}{}
			}
			if effort == "" {
				effort = "high"
			}
			if !wanted {
				effort = "none"
			}
			reasoning["effort"] = effort
			fields["reasoning"] = reasoning
			native = true
		}
	} else if _, ok := properties["thinking"]; ok {
		if wanted {
			nativeThinking, _ := fields["thinking"].(map[string]interface{})
			if nativeThinking == nil {
				nativeThinking = map[string]interface{}{}
			}
			nativeThinking["type"] = "adaptive"
			if thinking != nil && thinking.Display != "" {
				nativeThinking["display"] = thinking.Display
			}
			fields["thinking"] = nativeThinking
			native = true
		} else if thinking != nil && thinking.Type == "disabled" {
			fields["thinking"] = map[string]interface{}{"type": "disabled"}
		}
		if effort == "" && thinking != nil && thinking.Type == "enabled" {
			switch budget := thinking.BudgetTokens; {
			case budget <= 4000:
				effort = "low"
			case budget <= 16000:
				effort = "medium"
			case budget <= 64000:
				effort = "high"
			default:
				effort = "xhigh"
			}
		}
		if effort != "" && effort != "none" && effort != "minimal" {
			if output == nil {
				output = map[string]interface{}{}
			}
			output["effort"] = effort
			fields["output_config"] = output
			native = true
		}
	}
	if len(fields) > 0 {
		payload.AdditionalModelRequestFields = fields
	}
	if native && payload.LegacyThinkingPrompt {
		// Remove only the generated legacy activation prefix. Client system
		// text is retained after it, including its whitespace and image labels.
		history := payload.ConversationState.History
		if len(history) > 0 && history[0].UserInputMessage != nil {
			user := history[0].UserInputMessage
			if user.Content == ThinkingModePrompt {
				user.Content = ""
			} else {
				user.Content = strings.TrimPrefix(user.Content, ThinkingModePrompt+"\n\n")
			}
			if user.Content == "" && len(history) >= 2 && history[1].AssistantResponseMessage != nil && history[1].AssistantResponseMessage.Content == "I will follow these instructions." {
				// Remove only our activation-only priming pair. Sending an
				// empty user history entry is rejected by the Kiro schema.
				payload.ConversationState.History = history[2:]
			}
		}
	}
}
