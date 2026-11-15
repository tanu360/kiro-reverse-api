package config

import (
	"errors"
	"strings"
)

// Kiro has two chat APIs: generateAssistantResponse (AWS event stream), and CreateResponse
// (POST /v1/responses on runtime.{region}.kiro.dev, server-sent events), which the Kiro IDE
// uses for the accounts Kiro puts in its create_response_api experiment.
const (
	// ChatAPIAuto follows Kiro's per-account experiment flag, as the Kiro IDE does.
	ChatAPIAuto = "auto"
	// ChatAPIResponses sends every OAuth account's chat to /v1/responses.
	ChatAPIResponses = "responses"
	// ChatAPILegacy keeps every account on generateAssistantResponse.
	ChatAPILegacy = "legacy"
)

// ErrInvalidChatAPI is returned for a chat API mode other than auto, responses or legacy.
var ErrInvalidChatAPI = errors.New("invalid chat API, must be: auto, responses, or legacy")

// NormalizeChatAPI returns the stored spelling of a chat API mode, "" for an unknown one.
// An empty value is ChatAPIAuto.
func NormalizeChatAPI(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", ChatAPIAuto:
		return ChatAPIAuto
	case ChatAPIResponses:
		return ChatAPIResponses
	case ChatAPILegacy:
		return ChatAPILegacy
	}
	return ""
}

// GetChatAPI is the chat API mode: auto (the default), responses or legacy.
func GetChatAPI() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return ChatAPIAuto
	}
	if mode := NormalizeChatAPI(cfg.ChatAPI); mode != "" {
		return mode
	}
	return ChatAPIAuto
}

// UpdateChatAPI stores the chat API mode.
func UpdateChatAPI(mode string) error {
	normalized := NormalizeChatAPI(mode)
	if normalized == "" {
		return ErrInvalidChatAPI
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if normalized == ChatAPIAuto {
		normalized = ""
	}
	cfg.ChatAPI = normalized
	return Save()
}
