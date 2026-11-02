package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type responsesItemEvent struct {
	name, itemType, text string
	index                int
}

// runResponsesStreamOrder streams the given Kiro frames through /v1/responses and returns
// every output_item.added/done event in wire order.
func runResponsesStreamOrder(t *testing.T, frames func(t *testing.T) [][]byte) ([]responsesItemEvent, map[string]interface{}) {
	t.Helper()
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, frames(t)...)
	})
	body := `{"model":"claude-sonnet-4.5","input":"go","stream":true,"store":false,"reasoning":{"effort":"medium","summary":"auto"},"tools":[{"type":"function","name":"get_weather","parameters":{"type":"object"}}]}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var seq []responsesItemEvent
	var completed map[string]interface{}
	for _, event := range parseResponsesSSE(t, rec.Body.String()) {
		switch event.Name {
		case "response.output_item.added", "response.output_item.done":
			item := responseSSEMap(t, event.Data["item"])
			text := ""
			if content, ok := item["content"].([]interface{}); ok && len(content) > 0 {
				text, _ = responseSSEMap(t, content[0])["text"].(string)
			}
			seq = append(seq, responsesItemEvent{strings.TrimPrefix(event.Name, "response.output_item."), item["type"].(string), text, responseSSEInt(t, event.Data["output_index"])})
		case "response.completed":
			completed = responseSSEMap(t, event.Data["response"])
		}
	}
	return seq, completed
}

func assertItemsCloseInOrder(t *testing.T, seq []responsesItemEvent) {
	t.Helper()
	open := map[int]bool{}
	for _, ev := range seq {
		if ev.name == "added" {
			for idx := range open {
				t.Fatalf("item %d (%s) was added while item %d is still open: %+v", ev.index, ev.itemType, idx, seq)
			}
			open[ev.index] = true
			continue
		}
		if !open[ev.index] {
			t.Fatalf("item %d done without being open: %+v", ev.index, seq)
		}
		delete(open, ev.index)
	}
	if len(open) != 0 {
		t.Fatalf("items never closed: %v in %+v", open, seq)
	}
}

func TestResponsesStreamClosesMessageBeforeToolCall(t *testing.T) {
	seq, completed := runResponsesStreamOrder(t, func(t *testing.T) [][]byte {
		return [][]byte{
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Checking the weather."}),
			awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_1", "name": "get_weather", "input": `{"city":"Delhi"}`, "stop": true}),
			meteringFrame(t),
		}
	})
	assertItemsCloseInOrder(t, seq)
	var done []string
	for _, ev := range seq {
		if ev.name == "done" {
			done = append(done, ev.itemType)
		}
	}
	if strings.Join(done, ",") != "message,function_call" {
		t.Fatalf("done order = %v, want message before function_call", done)
	}
	if seq[1].text != "Checking the weather." {
		t.Fatalf("message closed with %q", seq[1].text)
	}
	output := completed["output"].([]interface{})
	if len(output) != 2 || responseSSEMap(t, output[0])["type"] != "message" || responseSSEMap(t, output[1])["type"] != "function_call" {
		t.Fatalf("completed output order: %+v", output)
	}
}

func TestResponsesStreamTextAfterToolCallOpensNewMessage(t *testing.T) {
	seq, completed := runResponsesStreamOrder(t, func(t *testing.T) [][]byte {
		return [][]byte{
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Before."}),
			awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_1", "name": "get_weather", "input": `{"city":"Delhi"}`, "stop": true}),
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "After."}),
			meteringFrame(t),
		}
	})
	assertItemsCloseInOrder(t, seq)
	var texts []string
	for _, ev := range seq {
		if ev.name == "done" && ev.itemType == "message" {
			texts = append(texts, ev.text)
		}
	}
	if strings.Join(texts, "|") != "Before.|After." {
		t.Fatalf("message items = %q, want each segment in its own item", texts)
	}
	output := completed["output"].([]interface{})
	if len(output) != 3 {
		t.Fatalf("completed output: %+v", output)
	}
	if completed["output_text"] != "Before.After." {
		t.Fatalf("output_text = %#v", completed["output_text"])
	}
}

func TestResponsesStreamClosesReasoningBeforeText(t *testing.T) {
	seq, completed := runResponsesStreamOrder(t, func(t *testing.T) [][]byte {
		return [][]byte{
			awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "plan it"}),
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "On it."}),
			awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_1", "name": "get_weather", "input": `{"city":"Delhi"}`, "stop": true}),
			meteringFrame(t),
		}
	})
	assertItemsCloseInOrder(t, seq)
	var done []string
	for _, ev := range seq {
		if ev.name == "done" {
			done = append(done, ev.itemType)
		}
	}
	if strings.Join(done, ",") != "reasoning,message,function_call" {
		t.Fatalf("done order = %v, want reasoning, message, function_call", done)
	}
	output := completed["output"].([]interface{})
	if len(output) != 3 || responseSSEMap(t, output[0])["type"] != "reasoning" {
		t.Fatalf("completed output order: %+v", output)
	}
}
