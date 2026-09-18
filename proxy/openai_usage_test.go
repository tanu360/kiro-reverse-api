package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func estimatedOpenAIPayload(currentContent string) *KiroPayload {
	payload := &KiroPayload{}
	payload.ConversationState.CurrentMessage.UserInputMessage = KiroUserInputMessage{
		Content: currentContent,
		ModelID: "claude-sonnet-4.5",
		Origin:  "AI_EDITOR",
	}
	payload.ConversationState.History = []KiroHistoryMessage{
		{UserInputMessage: &KiroUserInputMessage{
			Content: strings.Repeat("stable conversation prefix ", 260),
			ModelID: "claude-sonnet-4.5",
			Origin:  "AI_EDITOR",
		}},
		{AssistantResponseMessage: &KiroAssistantResponseMessage{
			Content: strings.Repeat("stable assistant reply ", 80),
		}},
	}
	return payload
}

func TestCacheEstimatesReachChatAndResponsesUsage(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, stream := range []bool{false, true} {
			t.Run(path+map[bool]string{false: "/json", true: "/sse"}[stream], func(t *testing.T) {
				h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
					writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "ok"}), meteringFrame(t))
				})
				messages := []map[string]interface{}{{"role": "user", "content": strings.Repeat("stable prefix ", 1000)}, {"role": "assistant", "content": "understood"}, {"role": "user", "content": "next"}}
				request := map[string]interface{}{"model": "claude-sonnet-4.5", "stream": stream}
				field := "prompt_tokens_details"
				if path == "/v1/responses" {
					request["input"] = messages
					field = "input_tokens_details"
				} else {
					request["messages"] = messages
				}
				for i := 0; i < 2; i++ {
					body, _ := json.Marshal(request)
					rec := httptest.NewRecorder()
					r := httptest.NewRequest("POST", path, strings.NewReader(string(body)))
					if path == "/v1/responses" {
						h.handleOpenAIResponses(rec, r)
					} else {
						h.handleOpenAIChat(rec, r)
					}
					if rec.Code != 200 {
						t.Fatalf("status %d", rec.Code)
					}
					var response map[string]interface{}
					if stream {
						for _, line := range strings.Split(rec.Body.String(), "\n") {
							if !strings.HasPrefix(line, "data: ") {
								continue
							}
							var event map[string]interface{}
							if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) != nil {
								continue
							}
							if event["usage"] != nil {
								response = event
							}
							if nested, ok := event["response"].(map[string]interface{}); ok && nested["usage"] != nil {
								response = nested
							}
						}
					} else if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
						t.Fatal(err)
					}
					usage, ok := response["usage"].(map[string]interface{})
					if !ok {
						t.Fatal("usage missing")
					}
					details, ok := usage[field].(map[string]interface{})
					if !ok || details["estimated"] != true {
						t.Fatalf("cache estimate missing: %+v", usage)
					}
					if i == 0 && details["cache_write_tokens"].(float64) <= 0 {
						t.Fatal("initial write estimate missing")
					}
					if i == 1 && details["cached_tokens"].(float64) <= 0 {
						t.Fatal("reused prefix not counted")
					}
				}
			})
		}
	}
}

func TestResolveOpenAICacheUsageEstimatedLifecycle(t *testing.T) {
	tracker := newPromptCacheTracker(time.Hour)
	firstPayload := estimatedOpenAIPayload("first dynamic user turn")

	first := resolveOpenAICacheUsage(tracker, "account-a", firstPayload, 4096)
	if first == nil {
		t.Fatalf("first cache usage = %#v, want estimated details", first)
	}
	if first.CacheWriteTokens <= 0 || first.CachedTokens != 0 {
		t.Fatalf("first cache details = %#v, want write-only estimate", first)
	}

	// Current message text is deliberately excluded from the stable-prefix
	// fingerprint, so a subsequent turn can reuse the stored prefix.
	secondPayload := estimatedOpenAIPayload("different dynamic user turn")
	second := resolveOpenAICacheUsage(tracker, "account-a", secondPayload, 4096)
	if second == nil {
		t.Fatalf("second cache usage = %#v, want estimated details", second)
	}
	if second.CachedTokens <= 0 || second.CacheWriteTokens != 0 {
		t.Fatalf("second cache details = %#v, want read-only estimate", second)
	}

	otherAccount := resolveOpenAICacheUsage(tracker, "account-b", secondPayload, 4096)
	if otherAccount == nil || otherAccount.CachedTokens != 0 || otherAccount.CacheWriteTokens <= 0 {
		t.Fatalf("other account cache details = %#v, want independent write-only estimate", otherAccount)
	}
}

func TestResolveOpenAICacheUsageHitsEarlierPrefixWhenHistoryGrows(t *testing.T) {
	tracker := newPromptCacheTracker(time.Hour)
	firstPayload := estimatedOpenAIPayload("first dynamic user turn")
	first := resolveOpenAICacheUsage(tracker, "account-a", firstPayload, 4096)
	if first == nil || first.CacheWriteTokens <= 0 {
		t.Fatalf("first cache usage = %#v, want write-only estimate", first)
	}

	// The next turn adds history after the already stored stable prefix. The
	// current user turn remains excluded, so the tracker must still find the
	// earlier cumulative history breakpoint.
	grownPayload := estimatedOpenAIPayload("second dynamic user turn")
	grownPayload.ConversationState.History = append(grownPayload.ConversationState.History,
		KiroHistoryMessage{UserInputMessage: &KiroUserInputMessage{
			Content: strings.Repeat("newer stable history ", 120),
			ModelID: "claude-sonnet-4.5",
			Origin:  "AI_EDITOR",
		}},
	)
	got := resolveOpenAICacheUsage(tracker, "account-a", grownPayload, 6144)
	if got == nil || got.CachedTokens <= 0 {
		t.Fatalf("grown history cache usage = %#v, want read from earlier prefix", got)
	}
}
