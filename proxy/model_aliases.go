package proxy

import (
	"kiro-proxy/config"
	"strings"
)

func appendConfiguredModelAliases(models []map[string]interface{}, suffix string) []map[string]interface{} {
	byID := make(map[string]map[string]interface{})
	result := make([]map[string]interface{}, 0, len(models))
	for _, model := range models {
		id, _ := model["id"].(string)
		key := strings.ToLower(id)
		if _, exists := byID[key]; exists {
			continue
		}
		byID[key] = model
		result = append(result, model)
	}
	for _, rule := range config.GetModelMappings() {
		ids := []string{rule.Key}
		if suffix != "" && !strings.HasSuffix(strings.ToLower(rule.Key), strings.ToLower(suffix)) {
			ids = append(ids, rule.Key+suffix)
		}
		for _, id := range ids {
			if strings.TrimSpace(id) == "" {
				continue
			}
			target, _ := ParseModelAndThinking(id, suffix)
			supportsImage := false
			if model := byID[strings.ToLower(target)]; model != nil {
				supportsImage, _ = model["supports_image"].(bool)
			}
			alias := buildModelInfo(id, "kiro-proxy", supportsImage)
			key := strings.ToLower(id)
			if existing := byID[key]; existing != nil {
				for k, v := range alias {
					existing[k] = v
				}
			} else {
				result = append(result, alias)
				byID[key] = alias
			}
		}
	}
	return result
}
