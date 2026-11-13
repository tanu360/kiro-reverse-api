package proxy

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"strings"
)

// codexBaseInstructions is the Codex CLI's own system prompt, as Codex 0.168 sends it for
// a model it has no metadata for (openai/codex, Copyright 2025 OpenAI, Apache-2.0;
// see THIRD_PARTY_NOTICES.md). A model_catalog_json entry must carry instructions:
// Codex refuses a catalog with none, and sends no system prompt at all for an empty
// one. So the catalog repeats Codex's prompt rather than a short one of its own, and
// Codex runs as it does without a catalog, plus the apply_patch tool.
//
//go:embed codex_base_instructions.md
var codexBaseInstructions string

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
	ModelMessages               *codexModelMessages   `json:"model_messages,omitempty"`
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

func (h *Handler) handleCodexModels(w http.ResponseWriter, r *http.Request) {
	if refuseMethod(w, r, errorShapeOpenAI, http.MethodGet) {
		return
	}
	//! Like /v1/models: before the first listing the cache is empty, and the built-in
	//! fallback names models a free account does not serve.
	models := buildCodexModelsResponse(h.filterModelInfosForAPIKey(r.Context(), h.cachedModelsSnapshot(true)))
	if len(models) == 0 {
		models = buildCodexModelsResponse(h.filterModelInfosForAPIKey(r.Context(), fallbackCodexModelInfos()))
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

// buildCodexModelsResponse lists one entry per model, with no "-thinking" twin: on the
// Responses path any reasoning effort above minimal already turns thinking on.
func buildCodexModelsResponse(models []ModelInfo) []codexModelEntry {
	entries := make([]codexModelEntry, 0, len(models)+len(codexCompatibilityAliases))
	seen := make(map[string]bool, len(models))
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

		entries = append(entries, buildCodexModelEntry(id, displayName, description, contextWindow, supportsImage, priority))
		priority++
	}

	for _, alias := range codexCompatibilityAliases {
		//! An alias whose mapped model is not served here fails upstream, so it is not listed.
		if seen[strings.ToLower(alias.slug)] || !seen[strings.ToLower(MapModel(alias.slug))] {
			continue
		}
		entries = append(entries, buildCodexModelEntry(alias.slug, alias.displayName, "Compatibility alias: "+alias.slug, alias.contextWindow, true, priority))
		priority++
	}

	return entries
}

func buildCodexModelEntry(id, displayName, description string, contextWindow int, supportsImage bool, priority int) codexModelEntry {
	if contextWindow <= 0 {
		contextWindow = 200000
	}

	inputModalities := []string{"text"}
	if supportsImage {
		inputModalities = append(inputModalities, "image")
	}

	reasoningLevels := []codexReasoningLevel{
		{Effort: "low", Description: "Fast responses"},
		{Effort: "medium", Description: "Balanced reasoning"},
		{Effort: "high", Description: "Deep reasoning"},
		{Effort: "xhigh", Description: "Extra high reasoning"},
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
		DefaultReasoningLevel:       "medium",
		SupportedReasoningLevels:    reasoningLevels,
		DefaultReasoningSummary:     "none",
		ReasoningSummaryFormat:      "none",
		SupportsReasoningSummaries:  false,
		DefaultVerbosity:            "low",
		SupportVerbosity:            false,
		ApplyPatchToolType:          "freeform",
		WebSearchToolType:           "text_and_image",
		SupportsSearchTool:          true,
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
		//! No model_messages: its instructions_template would replace base_instructions.
		BaseInstructions:    codexBaseInstructions,
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

var codexCompatibilityAliases = []struct {
	slug, displayName string
	contextWindow     int
}{
	{"gpt-5.4-mini", "GPT 5.4 Mini", 200000},
	{"gpt-5", "GPT 5", 200000},
	{"gpt-4o", "GPT 4o", 128000},
	{"gpt-4", "GPT 4", 8192},
}

func fallbackCodexModelInfos() []ModelInfo {
	return []ModelInfo{
		{ModelId: "auto", ModelName: "Auto", Description: "Models chosen by task for optimal usage and consistent quality", InputTypes: []string{"TEXT", "IMAGE"}, TokenLimits: &struct {
			MaxInputTokens  int `json:"maxInputTokens"`
			MaxOutputTokens int `json:"maxOutputTokens"`
		}{MaxInputTokens: 200000, MaxOutputTokens: 64000}},
		{ModelId: "claude-sonnet-5", ModelName: "Claude Sonnet 5", InputTypes: []string{"TEXT", "IMAGE"}},
		{ModelId: "claude-opus-5", ModelName: "Claude Opus 5", InputTypes: []string{"TEXT", "IMAGE"}},
		{ModelId: "claude-sonnet-4.5", ModelName: "Claude Sonnet 4.5", InputTypes: []string{"TEXT", "IMAGE"}},
		{ModelId: "claude-haiku-4.5", ModelName: "Claude Haiku 4.5", InputTypes: []string{"TEXT", "IMAGE"}},
	}
}
