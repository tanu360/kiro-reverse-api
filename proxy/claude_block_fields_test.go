package proxy

import (
	"encoding/json"
	"testing"
)

func TestClaudeContentBlocksAlwaysCarryTheirFields(t *testing.T) {
	cases := []struct {
		block ClaudeContentBlock
		want  string
	}{
		{ClaudeContentBlock{Type: "thinking"}, `{"type":"thinking","thinking":"","signature":""}`},
		{ClaudeContentBlock{Type: "thinking", Thinking: "t", Signature: "s"}, `{"type":"thinking","thinking":"t","signature":"s"}`},
		{ClaudeContentBlock{Type: "text"}, `{"type":"text","text":""}`},
		{ClaudeContentBlock{Type: "redacted_thinking", Data: "d"}, `{"type":"redacted_thinking","data":"d"}`},
		{ClaudeContentBlock{Type: "tool_use", ID: "t1", Name: "f"}, `{"type":"tool_use","id":"t1","name":"f","input":{}}`},
		{ClaudeContentBlock{Type: "image", Source: &ImageSource{Type: "base64", MediaType: "image/png", Data: "x"}}, `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"x"}}`},
	}
	for _, c := range cases {
		got, err := json.Marshal(c.block)
		if err != nil || string(got) != c.want {
			t.Fatalf("%s: got %s %v, want %s", c.block.Type, got, err, c.want)
		}
	}
	// The display:"omitted" response, as the SDK decodes it.
	resp := KiroToClaudeResponse("42", "", true, nil, 1, 1, "claude-haiku-4.5")
	data, _ := json.Marshal(resp)
	var decoded struct {
		Content []map[string]interface{} `json:"content"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if thinking, ok := decoded.Content[0]["thinking"].(string); !ok || thinking != "" {
		t.Fatalf("omitted thinking block = %v, want thinking as an empty string", decoded.Content[0])
	}
	if _, ok := decoded.Content[0]["signature"].(string); !ok {
		t.Fatalf("omitted thinking block = %v, want a signature string", decoded.Content[0])
	}
}
