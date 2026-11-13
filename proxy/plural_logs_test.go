package proxy

import (
	"strings"
	"testing"

	"kiro-proxy/config"
)

// Counts in log lines read as plain English: "1 redacted_thinking block", never "block(s)".
func TestRedactedThinkingDropLogCountsInPlainEnglish(t *testing.T) {
	redacted := map[string]interface{}{"type": "redacted_thinking", "data": "enc"}
	text := map[string]interface{}{"type": "text", "text": "hi"}
	for _, c := range []struct {
		blocks []interface{}
		want   string
	}{
		{[]interface{}{redacted, text}, "Dropping 1 redacted_thinking block: "},
		{[]interface{}{redacted, redacted, text}, "Dropping 2 redacted_thinking blocks: "},
	} {
		logs := captureLogs(t)
		extractClaudeAssistantHistory(c.blocks, true)
		out := logs.String()
		if !strings.Contains(out, c.want) || strings.Contains(out, "(s)") {
			t.Errorf("log %q, want %q and no \"(s)\"", out, c.want)
		}
	}
}

func TestUndecodableImageLogCountsInPlainEnglish(t *testing.T) {
	logs := captureLogs(t)
	logUndecodableImage(1)
	if out := logs.String(); !strings.Contains(out, "(1 character)") {
		t.Errorf("log %q, want \"(1 character)\"", out)
	}
}

func TestRestoredNativeModelsLogCountsInPlainEnglish(t *testing.T) {
	initDefaultMappingsConfig(t)
	t.Cleanup(func() { publishNativeModels(nil) })
	publishNativeModels(nil)
	if err := config.SaveNativeModelIDs([]string{"claude-haiku-4.5"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	logs := captureLogs(t)
	restoreNativeModels()
	if out := logs.String(); !strings.Contains(out, "Restored 1 native model from the last listing") {
		t.Errorf("log %q, want \"Restored 1 native model\"", out)
	}
}

func TestMaskedOlderRowsLogCountsInPlainEnglish(t *testing.T) {
	setupApiKeyUsageTest(t)
	key := addUsageKey(t, "on", "sk-plural-0123456789abcdef", true)
	insertUsageRows(t, usageRow{ts: 100, keyID: key.ID, key: key.Key, success: true})
	logs := captureLogs(t)
	if err := scrubStoredRequestKeys(); err != nil {
		t.Fatal(err)
	}
	if out := logs.String(); !strings.Contains(out, "Masked the client key on 1 older request log row\n") {
		t.Errorf("log %q, want \"on 1 older request log row\"", out)
	}
}
