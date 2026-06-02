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
	if native, ok := resolveModelEffort(effort, h.effortLevelsForModel(model)); ok {
		payload.AdditionalModelRequestFields = map[string]interface{}{
			"output_config": map[string]interface{}{"effort": native},
		}
	}
}

func (h *Handler) effortLevelsForModel(model string) []string {
	model = strings.ToLower(strings.TrimSpace(model))
	if model == "" {
		return nil
	}
	h.modelsCacheMu.RLock()
	defer h.modelsCacheMu.RUnlock()
	for _, m := range h.cachedModels {
		if strings.EqualFold(strings.TrimSpace(m.ModelId), model) {
			return effortLevelsFromSchema(m.AdditionalModelRequestFieldsSchema)
		}
	}
	return nil
}

func effortLevelsFromSchema(schema map[string]interface{}) []string {
	if len(schema) == 0 {
		return nil
	}
	outputConfig, _ := nestedSchemaMap(schema, "properties", "output_config")
	effort, _ := nestedSchemaMap(outputConfig, "properties", "effort")
	rawEnum, ok := effort["enum"].([]interface{})
	if !ok {
		return nil
	}
	levels := make([]string, 0, len(rawEnum))
	for _, raw := range rawEnum {
		if s, ok := raw.(string); ok {
			if normalized := normalizeReasoningEffort(s); normalized != effortUnset && normalized != effortMinimal {
				levels = append(levels, normalized)
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
			best = normalized
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
			lowest = normalized
			lowestRank = rank
		}
	}
	return lowest, lowest != ""
}
