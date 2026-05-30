package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"strings"
)

type codexModelsResponse struct {
	Models []codexModelEntry `json:"models"`
}

type codexModelEntry struct {
	Slug                        string                `json:"slug"`
	Model                       string                `json:"model"`
	DisplayName                 string                `json:"display_name"`
	Description                 string                `json:"description"`
	ContextWindow               int                   `json:"context_window"`
	MaxContextWindow            int                   `json:"max_context_window"`
	AutoCompactTokenLimit       int                   `json:"auto_compact_token_limit"`
	TruncationPolicy            codexTruncationPolicy `json:"truncation_policy"`
	DefaultReasoningLevel       string                `json:"default_reasoning_level"`
	SupportedReasoningLevels    []codexReasoningLevel `json:"supported_reasoning_levels"`
	DefaultReasoningSummary     string                `json:"default_reasoning_summary"`
	ReasoningSummaryFormat      string                `json:"reasoning_summary_format"`
	SupportsReasoningSummaries  bool                  `json:"supports_reasoning_summaries"`
	DefaultVerbosity            string                `json:"default_verbosity"`
	SupportVerbosity            bool                  `json:"support_verbosity"`
	ApplyPatchToolType          string                `json:"apply_patch_tool_type"`
	WebSearchToolType           string                `json:"web_search_tool_type"`
	SupportsSearchTool          bool                  `json:"supports_search_tool"`
	SupportsParallelToolCalls   bool                  `json:"supports_parallel_tool_calls"`
	ExperimentalSupportedTools  []string              `json:"experimental_supported_tools"`
	InputModalities             []string              `json:"input_modalities"`
	SupportsImageDetailOriginal bool                  `json:"supports_image_detail_original"`
	ShellType                   string                `json:"shell_type"`
	Visibility                  string                `json:"visibility"`
	MinimalClientVersion        string                `json:"minimal_client_version"`
	SupportedInAPI              bool                  `json:"supported_in_api"`
	AvailabilityNUX             interface{}           `json:"availability_nux"`
	Upgrade                     interface{}           `json:"upgrade"`
	Priority                    int                   `json:"priority"`
	PreferWebsockets            bool                  `json:"prefer_websockets"`
	AvailableInPlans            []string              `json:"available_in_plans"`
	BaseInstructions            string                `json:"base_instructions"`
	ModelMessages               codexModelMessages    `json:"model_messages"`
	SupportsComputerUse         bool                  `json:"supports_computer_use"`
	SupportsMCP                 bool                  `json:"supports_mcp"`
	VisionBridgeEnabled         bool                  `json:"vision_bridge_enabled"`
}

type codexTruncationPolicy struct {
	Mode  string `json:"mode"`
	Limit int    `json:"limit"`
}

type codexReasoningLevel struct {
	Effort      string `json:"effort"`
	Description string `json:"description"`
}

type codexModelMessages struct {
	InstructionsTemplate  string            `json:"instructions_template"`
	InstructionsVariables map[string]string `json:"instructions_variables"`
}

func (h *Handler) handleCodexModels(w http.ResponseWriter, _ *http.Request) {
	cached := h.cachedModelsSnapshot(true)
	thinkingSuffix := config.GetThinkingConfig().Suffix

	models := buildCodexModelsResponse(cached, thinkingSuffix)
	if len(models) == 0 {
		models = buildCodexModelsResponse(fallbackCodexModelInfos(), thinkingSuffix)
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(codexModelsResponse{Models: models})
}

func (h *Handler) cachedModelsSnapshot(refreshIfEmpty bool) []ModelInfo {
	h.modelsCacheMu.RLock()
	cached := append([]ModelInfo(nil), h.cachedModels...)
	h.modelsCacheMu.RUnlock()

	if refreshIfEmpty && len(cached) == 0 {
		h.refreshModelsCache()
		h.modelsCacheMu.RLock()
		cached = append([]ModelInfo(nil), h.cachedModels...)
		h.modelsCacheMu.RUnlock()
	}
	return cached
}

func buildCodexModelsResponse(models []ModelInfo, thinkingSuffix string) []codexModelEntry {
	if thinkingSuffix == "" {
		thinkingSuffix = "-thinking"
	}

	entries := make([]codexModelEntry, 0, len(models)*2+2)
	seen := make(map[string]bool, len(models)*2+2)
	priority := 1
	for _, model := range models {
		id := strings.TrimSpace(model.ModelId)
		if id == "" {
			continue
		}
		if seen[strings.ToLower(id)] {
			continue
		}
		seen[strings.ToLower(id)] = true

		displayName := strings.TrimSpace(model.ModelName)
		if displayName == "" {
			displayName = displayNameFromModelID(id)
		}
		description := strings.TrimSpace(model.Description)
		if description == "" {
			description = "Custom model: " + id
		}
		supportsImage := modelSupportsImage(model.InputTypes)
		contextWindow := modelContextWindow(model)

		entries = append(entries, buildCodexModelEntry(id, displayName, description, contextWindow, supportsImage, false, priority))
		priority++

		thinkingID := id + thinkingSuffix
		seen[strings.ToLower(thinkingID)] = true
		entries = append(entries, buildCodexModelEntry(
			thinkingID,
			displayName+" Thinking",
			"Thinking variant: "+description,
			contextWindow,
			supportsImage,
			true,
			priority,
		))
		priority++
	}

	for _, alias := range codexCompatibilityAliases(priority) {
		if seen[strings.ToLower(alias.Slug)] {
			continue
		}
		entries = append(entries, alias)
		priority++
	}

	return entries
}

func buildCodexModelEntry(id, displayName, description string, contextWindow int, supportsImage, thinking bool, priority int) codexModelEntry {
	if contextWindow <= 0 {
		contextWindow = 200000
	}

	inputModalities := []string{"text"}
	if supportsImage {
		inputModalities = append(inputModalities, "image")
	}

	defaultReasoningLevel := "medium"
	reasoningLevels := []codexReasoningLevel{
		{Effort: "low", Description: "Fast responses"},
		{Effort: "medium", Description: "Balanced reasoning"},
		{Effort: "high", Description: "Deep reasoning"},
	}
	if thinking {
		defaultReasoningLevel = "high"
		reasoningLevels = []codexReasoningLevel{
			{Effort: "medium", Description: "Balanced reasoning"},
			{Effort: "high", Description: "Deep reasoning"},
			{Effort: "xhigh", Description: "Extra high reasoning"},
		}
	}

	return codexModelEntry{
		Slug:                        id,
		Model:                       id,
		DisplayName:                 displayName,
		Description:                 description,
		ContextWindow:               contextWindow,
		MaxContextWindow:            contextWindow,
		AutoCompactTokenLimit:       scaledTokenLimit(contextWindow, 0.8),
		TruncationPolicy:            codexTruncationPolicy{Mode: "tokens", Limit: scaledTokenLimit(contextWindow, 0.32)},
		DefaultReasoningLevel:       defaultReasoningLevel,
		SupportedReasoningLevels:    reasoningLevels,
		DefaultReasoningSummary:     "none",
		ReasoningSummaryFormat:      "none",
		SupportsReasoningSummaries:  false,
		DefaultVerbosity:            "low",
		SupportVerbosity:            false,
		ApplyPatchToolType:          "freeform",
		WebSearchToolType:           "text_and_image",
		SupportsSearchTool:          false,
		SupportsParallelToolCalls:   true,
		ExperimentalSupportedTools:  []string{"computer_use", "mcp"},
		InputModalities:             inputModalities,
		SupportsImageDetailOriginal: supportsImage,
		ShellType:                   "shell_command",
		Visibility:                  "list",
		MinimalClientVersion:        "0.0.1",
		SupportedInAPI:              true,
		AvailabilityNUX:             nil,
		Upgrade:                     nil,
		Priority:                    priority,
		PreferWebsockets:            false,
		AvailableInPlans:            []string{"free", "plus", "pro", "team", "business", "enterprise"},
		BaseInstructions:            "You are a coding agent running in Codex through a local BYOK shim.",
		ModelMessages: codexModelMessages{
			InstructionsTemplate: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
			InstructionsVariables: map[string]string{
				"model_name": id,
			},
		},
		SupportsComputerUse: true,
		SupportsMCP:         true,
		VisionBridgeEnabled: false,
	}
}

func modelContextWindow(model ModelInfo) int {
	if model.TokenLimits != nil && model.TokenLimits.MaxInputTokens > 0 {
		return model.TokenLimits.MaxInputTokens
	}
	return 200000
}

func scaledTokenLimit(contextWindow int, factor float64) int {
	if contextWindow <= 0 {
		return 0
	}
	return int(float64(contextWindow) * factor)
}

func displayNameFromModelID(id string) string {
	parts := strings.FieldsFunc(id, func(r rune) bool {
		return r == '-' || r == '_' || r == '.'
	})
	for i, part := range parts {
		if part == "" {
			continue
		}
		lower := strings.ToLower(part)
		switch lower {
		case "gpt", "glm":
			parts[i] = strings.ToUpper(part)
		default:
			parts[i] = strings.ToUpper(part[:1]) + strings.ToLower(part[1:])
		}
	}
	return strings.Join(parts, " ")
}

func codexCompatibilityAliases(priority int) []codexModelEntry {
	return []codexModelEntry{
		buildCodexModelEntry("gpt-4o", "GPT 4o", "Custom model: gpt-4o", 128000, true, false, priority),
		buildCodexModelEntry("gpt-4", "GPT 4", "Custom model: gpt-4", 8192, true, false, priority+1),
	}
}

func fallbackCodexModelInfos() []ModelInfo {
	return []ModelInfo{
		{ModelId: "auto", ModelName: "Auto", Description: "Models chosen by task for optimal usage and consistent quality", InputTypes: []string{"TEXT", "IMAGE"}, TokenLimits: &struct {
			MaxInputTokens  int `json:"maxInputTokens"`
			MaxOutputTokens int `json:"maxOutputTokens"`
		}{MaxInputTokens: 200000, MaxOutputTokens: 64000}},
		{ModelId: "claude-sonnet-4.6", ModelName: "Claude Sonnet 4.6", InputTypes: []string{"TEXT", "IMAGE"}},
		{ModelId: "claude-opus-4.6", ModelName: "Claude Opus 4.6", InputTypes: []string{"TEXT", "IMAGE"}},
		{ModelId: "claude-sonnet-4.5", ModelName: "Claude Sonnet 4.5", InputTypes: []string{"TEXT", "IMAGE"}},
		{ModelId: "claude-haiku-4.5", ModelName: "Claude Haiku 4.5", InputTypes: []string{"TEXT", "IMAGE"}},
	}
}
