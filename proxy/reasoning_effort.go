package proxy

import "strings"

const (
	effortUnset   = ""
	effortMinimal = "minimal"
	effortLow     = "low"
	effortMedium  = "medium"
	effortHigh    = "high"
	effortXHigh   = "xhigh"
)

var effortOrder = map[string]int{
	effortLow:    1,
	effortMedium: 2,
	effortHigh:   3,
	effortXHigh:  4,
}

func normalizeReasoningEffort(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "none", "off", "disabled":
		return effortUnset
	case "minimal", "min":
		return effortMinimal
	case "low":
		return effortLow
	case "medium", "med":
		return effortMedium
	case "high":
		return effortHigh
	case "xhigh", "extra_high", "extra-high", "max", "maximum":
		return effortXHigh
	default:
		return effortUnset
	}
}

func resolveThinkingWithEffort(current bool, rawEffort string) bool {
	switch normalizeReasoningEffort(rawEffort) {
	case effortUnset:
		return current
	case effortMinimal:
		return false
	default:
		return true
	}
}

func (h *Handler) applyReasoningEffort(payload *KiroPayload, model, rawEffort string) {
	effort := normalizeReasoningEffort(rawEffort)
	if payload == nil || effort == effortUnset || effort == effortMinimal {
		return
	}
	//! Kiro lists models by their own id; the client's name may carry -thinking or be an alias.
	if id := currentMessageModelID(payload); id != "" {
		model = id
	}
	field, levels := h.effortSettingForModel(model)
	if native, ok := resolveModelEffort(effort, levels); ok {
		payload.AdditionalModelRequestFields = map[string]interface{}{
			field: map[string]interface{}{"effort": native},
		}
		return
	}
	//! No FREE model lists an effort schema, so the level only switched thinking on: low and
	//! xhigh thought the same. The thinking prompt's length now follows the level instead.
	setThinkingLength(payload, effortThinkingLength[effort])
}

// effortSettingForModel is where model takes an effort level and the levels it lists.
func (h *Handler) effortSettingForModel(model string) (string, []string) {
	schema, _ := h.modelRequestFieldsSchema(model)
	return effortSettingFromSchema(schema)
}

// modelRequestFieldsSchema is the additionalModelRequestFieldsSchema Kiro lists for model, and
// whether Kiro lists model at all.
func (h *Handler) modelRequestFieldsSchema(model string) (map[string]interface{}, bool) {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil, false
	}
	h.modelsCacheMu.RLock()
	defer h.modelsCacheMu.RUnlock()
	for _, m := range h.cachedModels {
		if strings.EqualFold(strings.TrimSpace(m.ModelId), model) {
			return m.AdditionalModelRequestFieldsSchema, true
		}
	}
	return nil, false
}

// effortSettingFromSchema is the request field that takes the effort level and the levels its
// enum lists: Claude models list output_config.effort, and GPT, Grok and Kimi reasoning.effort.
func effortSettingFromSchema(schema map[string]interface{}) (string, []string) {
	for _, field := range []string{"output_config", "reasoning"} {
		if levels := effortLevelsFromSchema(schema, field); len(levels) > 0 {
			return field, levels
		}
	}
	return "", nil
}

func effortLevelsFromSchema(schema map[string]interface{}, field string) []string {
	if len(schema) == 0 {
		return nil
	}
	parent, _ := nestedSchemaMap(schema, "properties", field)
	effort, _ := nestedSchemaMap(parent, "properties", "effort")
	rawEnum, ok := effort["enum"].([]interface{})
	if !ok {
		return nil
	}
	levels := make([]string, 0, len(rawEnum))
	for _, raw := range rawEnum {
		if s, ok := raw.(string); ok {
			//! Keep the schema's spelling: upstream validates against its own enum, so a
			//! model advertising "max" rejects the normalized "xhigh".
			if normalized := normalizeReasoningEffort(s); normalized != effortUnset && normalized != effortMinimal {
				levels = append(levels, strings.TrimSpace(s))
			}
		}
	}
	return levels
}

func nestedSchemaMap(root map[string]interface{}, keys ...string) (map[string]interface{}, bool) {
	current := root
	for _, key := range keys {
		if current == nil {
			return nil, false
		}
		next, ok := current[key].(map[string]interface{})
		if !ok {
			return nil, false
		}
		current = next
	}
	return current, true
}

func resolveModelEffort(rawEffort string, supportedLevels []string) (string, bool) {
	effort := normalizeReasoningEffort(rawEffort)
	if effort == effortUnset || effort == effortMinimal || len(supportedLevels) == 0 {
		return "", false
	}
	target := effortOrder[effort]
	best := ""
	bestRank := -1
	for _, level := range supportedLevels {
		normalized := normalizeReasoningEffort(level)
		rank, ok := effortOrder[normalized]
		if !ok {
			continue
		}
		if rank <= target && rank > bestRank {
			best = level
			bestRank = rank
		}
	}
	if best != "" {
		return best, true
	}
	lowest := ""
	lowestRank := 1 << 30
	for _, level := range supportedLevels {
		normalized := normalizeReasoningEffort(level)
		rank, ok := effortOrder[normalized]
		if ok && rank < lowestRank {
			lowest = level
			lowestRank = rank
		}
	}
	return lowest, lowest != ""
}
