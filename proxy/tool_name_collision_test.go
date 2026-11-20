package proxy

import "testing"

// Live 2026-11-20: tools named get_weather and get-weather (or two names over 64 characters
// that share their first 64) both became one Kiro name, and Kiro answered 400 TOOL_DUPLICATE
// "The tool getWeather is already defined" to every request that declared them.
func TestConvertClaudeToolsKeepsCollidingNamesApart(t *testing.T) {
	long := ""
	for len(long) < 70 {
		long += "a"
	}
	names := []string{"get_weather", "get-weather", "getWeather", long + "_first", long + "_second"}
	tools := make([]ClaudeTool, 0, len(names))
	for _, name := range names {
		tools = append(tools, ClaudeTool{Name: name, InputSchema: map[string]interface{}{"type": "object"}})
	}
	kiroTools, nameMap := convertClaudeTools(tools)
	if len(kiroTools) != len(names) {
		t.Fatalf("got %d Kiro tools, want %d", len(kiroTools), len(names))
	}
	seen := map[string]bool{}
	for i, tool := range kiroTools {
		kiroName := tool.ToolSpecification.Name
		if seen[kiroName] {
			t.Fatalf("Kiro name %q declared twice", kiroName)
		}
		seen[kiroName] = true
		if len(kiroName) > 64 {
			t.Fatalf("Kiro name %q is over 64 characters", kiroName)
		}
		client := kiroName
		if mapped, ok := nameMap[kiroName]; ok {
			client = mapped
		}
		if client != names[i] {
			t.Fatalf("Kiro name %q maps back to %q, want %q", kiroName, client, names[i])
		}
	}
}
