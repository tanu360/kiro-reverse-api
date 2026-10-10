package proxy

import (
	"encoding/json"
	"net/http"
	"testing"
)

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

func effortSchemaModel(id string, levels ...interface{}) ModelInfo {
	return ModelInfo{
		ModelId: id,
		AdditionalModelRequestFieldsSchema: map[string]interface{}{
			"properties": map[string]interface{}{
				"output_config": map[string]interface{}{
					"properties": map[string]interface{}{
						"effort": map[string]interface{}{"enum": levels},
					},
				},
			},
		},
	}
}

// captureAdditionalFields records the additionalModelRequestFields of every upstream call.
func captureAdditionalFields(t *testing.T, calls chan<- map[string]interface{}) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var payload KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		calls <- payload.AdditionalModelRequestFields
		writeKiroTextResponse(t, w, "ok")
	}
}

func TestClaudeMessagesForwardsOutputConfigEffort(t *testing.T) {
	cases := []struct {
		name, body, want string
	}{
		{
			name: "adaptive thinking",
			body: `{"model":"claude-opus-4.8","max_tokens":64,"thinking":{"type":"adaptive"},"output_config":{"effort":"high"},
				"messages":[{"role":"user","content":"hi"}]}`,
			want: "high",
		},
		{
			name: "effort without thinking, streaming",
			body: `{"model":"claude-opus-4.8","max_tokens":64,"stream":true,"output_config":{"effort":"low"},
				"messages":[{"role":"user","content":"hi"}]}`,
			want: "low",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := make(chan map[string]interface{}, 1)
			h := newStreamTestHandler(t, captureAdditionalFields(t, calls))
			h.cachedModels = []ModelInfo{effortSchemaModel("claude-opus-4.8", "low", "medium", "high")}

			if rec := postClaudeMessages(t, h, tc.body); rec.Code != http.StatusOK {
				t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
			}
			fields := <-calls
			outputConfig, _ := fields["output_config"].(map[string]interface{})
			if outputConfig["effort"] != tc.want {
				t.Fatalf("additionalModelRequestFields = %#v, want output_config.effort=%q", fields, tc.want)
			}
		})
	}
}

func TestClaudeWebSearchLoopForwardsOutputConfigEffort(t *testing.T) {
	calls := make(chan map[string]interface{}, 1)
	h := newStreamTestHandler(t, captureAdditionalFields(t, calls))
	h.cachedModels = []ModelInfo{effortSchemaModel("claude-opus-4.8", "low", "medium", "high")}

	decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-opus-4.8","max_tokens":64,"output_config":{"effort":"medium"},
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"What is the latest Go?"}]}`))

	fields := <-calls
	outputConfig, _ := fields["output_config"].(map[string]interface{})
	if outputConfig["effort"] != "medium" {
		t.Fatalf("additionalModelRequestFields = %#v, want output_config.effort=medium", fields)
	}
}
