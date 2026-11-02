package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResponsesToolOutputImageBecomesOneKiroImage(t *testing.T) {
	imageData := noisyPNG(t, 64, 64)
	for _, tc := range []struct{ call, output string }{
		{`{"type":"function_call","call_id":"call_1","name":"screenshot","arguments":"{}"}`, "function_call_output"},
		{`{"type":"custom_tool_call","call_id":"call_1","name":"screenshot","input":"page"}`, "custom_tool_call_output"},
	} {
		t.Run(tc.output, func(t *testing.T) {
			input := `[{"type":"message","role":"user","content":[{"type":"input_text","text":"take a screenshot"}]},` + tc.call + `,` +
				`{"type":"` + tc.output + `","call_id":"call_1","output":[{"type":"input_text","text":"captured"},{"type":"input_image","image_url":"data:image/png;base64,` + imageData + `"}]}]`
			prepared, msg := prepareResponsesRequest(&OpenAIResponsesRequest{
				Model: "claude-sonnet-4.5",
				Input: json.RawMessage(input),
				Tools: []OpenAIResponsesTool{{Type: "function", Name: "screenshot", Parameters: map[string]interface{}{"type": "object"}}},
			}, nil)
			if msg != "" {
				t.Fatalf("validation error: %s", msg)
			}
			payload := OpenAIToKiro(&prepared.OpenAIRequest, false)

			current := payload.ConversationState.CurrentMessage.UserInputMessage
			images := len(current.Images)
			for _, h := range payload.ConversationState.History {
				if h.UserInputMessage != nil {
					images += len(h.UserInputMessage.Images)
				}
			}
			if images != 1 || len(current.Images) != 1 || current.Images[0].Source.Bytes != imageData {
				t.Fatalf("Kiro images = %d (current %d), want exactly the tool output image once", images, len(current.Images))
			}

			payload.ConversationState.CurrentMessage.UserInputMessage.Images = nil
			for _, h := range payload.ConversationState.History {
				if h.UserInputMessage != nil {
					h.UserInputMessage.Images = nil
				}
			}
			text, _ := json.Marshal(payload)
			if strings.Contains(string(text), imageData[:64]) {
				t.Fatal("image base64 leaked into text")
			}
			if !strings.Contains(string(text), "captured") {
				t.Fatal("tool output text lost")
			}
		})
	}
}

func TestResponsesTopLevelNamespaceToolsRoundTripOverSSE(t *testing.T) {
	body := `{"model":"claude-sonnet-4.5","stream":true,"input":"delegate this","tools":[` +
		`{"type":"namespace","name":"collaboration","description":"Sub-agent tools.","tools":[` +
		`{"type":"function","name":"spawn_agent","parameters":{"type":"object","properties":{"task":{"type":"string"}}}},` +
		`{"type":"function","name":"wait_agent","parameters":{"type":"object","properties":{"id":{"type":"string"}}}}]}]}`

	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var p KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			t.Error(err)
			return
		}
		declared := map[string]bool{}
		if ctx := p.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext; ctx != nil {
			for _, tool := range ctx.Tools {
				declared[tool.ToolSpecification.Name] = true
			}
		}
		if !declared["collaborationSpawnAgent"] || !declared["collaborationWaitAgent"] || len(declared) != 2 {
			t.Errorf("Kiro tools = %v", declared)
		}
		writeFrames(w,
			awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_spawn", "name": "collaborationSpawnAgent", "input": `{"task":"x"}`, "stop": true}),
			awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_wait", "name": "collaborationWaitAgent", "input": `{"id":"a1"}`, "stop": true}),
			meteringFrame(t))
	})
	rec := httptest.NewRecorder()
	h.handleOpenAIResponses(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}

	var output []map[string]interface{}
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		var event struct {
			Type     string `json:"type"`
			Response struct {
				Output []map[string]interface{} `json:"output"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(data), &event) == nil && event.Type == "response.completed" {
			output = event.Response.Output
		}
	}
	if len(output) != 2 {
		t.Fatalf("output items = %d: %s", len(output), rec.Body.String())
	}
	for i, want := range []string{"spawn_agent", "wait_agent"} {
		if output[i]["type"] != "function_call" || output[i]["name"] != want || output[i]["namespace"] != "collaboration" {
			t.Errorf("output[%d] = %+v, want {name:%s namespace:collaboration}", i, output[i], want)
		}
	}
}
