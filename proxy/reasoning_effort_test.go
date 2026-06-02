package proxy

import "testing"

func TestResolveThinkingWithReasoningEffortFallback(t *testing.T) {
	if resolveThinkingWithEffort(true, "minimal") {
		t.Fatalf("minimal effort should disable thinking fallback")
	}
	if !resolveThinkingWithEffort(false, "low") {
		t.Fatalf("low effort should enable thinking fallback")
	}
	if resolveThinkingWithEffort(false, "") {
		t.Fatalf("empty effort should preserve current thinking state")
	}
}

func TestApplyReasoningEffortUsesSupportedModelSchema(t *testing.T) {
	h := &Handler{
		cachedModels: []ModelInfo{{
			ModelId: "claude-opus-4.8",
			AdditionalModelRequestFieldsSchema: map[string]interface{}{
				"properties": map[string]interface{}{
					"output_config": map[string]interface{}{
						"properties": map[string]interface{}{
							"effort": map[string]interface{}{
								"enum": []interface{}{"low", "high"},
							},
						},
					},
				},
			},
		}},
	}
	payload := &KiroPayload{}
	h.applyReasoningEffort(payload, "claude-opus-4.8", "xhigh")

	outputConfig, ok := payload.AdditionalModelRequestFields["output_config"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected output_config in additional model request fields, got %#v", payload.AdditionalModelRequestFields)
	}
	if got := outputConfig["effort"]; got != "high" {
		t.Fatalf("expected xhigh to clamp to supported high, got %#v", got)
	}
}

func TestApplyReasoningEffortSkipsUnsupportedModelSchema(t *testing.T) {
	h := &Handler{cachedModels: []ModelInfo{{ModelId: "claude-sonnet-4.5"}}}
	payload := &KiroPayload{}
	h.applyReasoningEffort(payload, "claude-sonnet-4.5", "high")
	if payload.AdditionalModelRequestFields != nil {
		t.Fatalf("expected unsupported model to skip native effort forwarding, got %#v", payload.AdditionalModelRequestFields)
	}
}
