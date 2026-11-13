package config

// promptOverheadsKey holds what Kiro added to the prompts it counted, per model (see
// proxy/prompt_overhead.go), so a cut answer right after a restart still reports Kiro's count.
// Like native_models it stays out of the config row: it changes with traffic, not with an edit.
const promptOverheadsKey = "prompt_overheads"

// LoadPromptOverheads returns the saved table as JSON, or nil when none was saved.
func LoadPromptOverheads() ([]byte, error) {
	raw, ok, err := getSetting(promptOverheadsKey)
	if err != nil || !ok {
		return nil, err
	}
	return []byte(raw), nil
}

// SavePromptOverheads replaces the saved table.
func SavePromptOverheads(data []byte) error {
	return setSetting(promptOverheadsKey, string(data))
}
