package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postOK(t *testing.T, h *Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: status %d body %s", path, rec.Code, rec.Body.String())
	}
	return rec
}

// chatAnswerText joins a chat completion's content: every content delta of a stream, or the
// message content of a non-stream answer.
func chatAnswerText(t *testing.T, rec *httptest.ResponseRecorder, stream bool) string {
	t.Helper()
	if !stream {
		var resp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Choices) == 0 {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
		return resp.Choices[0].Message.Content
	}
	var text strings.Builder
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok || data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			t.Fatalf("decode %s: %v", data, err)
		}
		for _, choice := range chunk.Choices {
			text.WriteString(choice.Delta.Content)
		}
	}
	return text.String()
}

// responsesAnswerText is the Responses API's output text: the joined output_text deltas of a
// stream (checked against output_text.done), or the output_text parts of a non-stream answer.
func responsesAnswerText(t *testing.T, rec *httptest.ResponseRecorder, stream bool) string {
	t.Helper()
	if !stream {
		var resp struct {
			Output []struct {
				Type    string `json:"type"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"output"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
		var text strings.Builder
		for _, item := range resp.Output {
			for _, part := range item.Content {
				if part.Type == "output_text" {
					text.WriteString(part.Text)
				}
			}
		}
		return text.String()
	}
	var deltas strings.Builder
	done := ""
	for _, event := range parseResponsesSSE(t, rec.Body.String()) {
		switch event.Name {
		case "response.output_text.delta":
			deltas.WriteString(event.Data["delta"].(string))
		case "response.output_text.done":
			done = event.Data["text"].(string)
		}
	}
	if done != deltas.String() {
		t.Fatalf("output_text.done %q differs from the joined deltas %q", done, deltas.String())
	}
	return deltas.String()
}

// A turn cut at a stop sequence or at max_tokens ends with the exact text before the cut, in
// the stream and in the non-stream answer alike. The non-stream answer used to trim the space
// the stream had already sent ("1 2 3 4 " against "1 2 3 4").
func TestCutAnswersMatchBetweenStreamAndNonStream(t *testing.T) {
	cases := []struct {
		name     string
		chunks   []string
		messages string // the Messages request's limit fields
		chat     string // the Chat request's limit fields
		resp     string // the Responses request's limit fields
		want     string
	}{
		{
			name:     "stop sequence after a space",
			chunks:   []string{"ONE TWO THREE ", "FOUR FIVE SIX ", "SEVEN EIGHT"},
			messages: `"max_tokens":256,"stop_sequences":["SEVEN"]`,
			chat:     `"stop":["SEVEN"]`,
			want:     "ONE TWO THREE FOUR FIVE SIX ",
		},
		{
			name:     "stop sequence after a newline",
			chunks:   []string{"1\n2\n3\n", "4\n5\n6"},
			messages: `"max_tokens":256,"stop_sequences":["5"]`,
			chat:     `"stop":["5"]`,
			want:     "1\n2\n3\n4\n",
		},
		{
			//! Letters and spaces weigh 4 of 18 units: 2 tokens hold 9 of them, ending on a space.
			name:     "max_tokens cut after a space",
			chunks:   []string{"ab cd ef gh ij"},
			messages: `"max_tokens":2`,
			chat:     `"max_tokens":2`,
			resp:     `"max_output_tokens":2`,
			want:     "ab cd ef ",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
				frames := make([][]byte, 0, len(c.chunks)+1)
				for _, chunk := range c.chunks {
					frames = append(frames, answerFrame(t, chunk))
				}
				writeFrames(w, append(frames, meteringFrame(t))...)
			})
			for _, stream := range []bool{false, true} {
				flag := map[bool]string{true: "true", false: "false"}[stream]
				msg := postOK(t, h, "/v1/messages", `{"model":"claude-haiku-4.5",`+c.messages+`,"stream":`+flag+`,"messages":[{"role":"user","content":"count"}]}`)
				var got string
				if stream {
					got = claudeStreamText(t, msg.Body.String())
				} else {
					got = claudeMessageText(t, msg.Body.Bytes())
				}
				if got != c.want {
					t.Errorf("messages stream=%t: text %q, want %q", stream, got, c.want)
				}

				chat := postOK(t, h, "/v1/chat/completions", `{"model":"claude-haiku-4.5",`+c.chat+`,"stream":`+flag+`,"messages":[{"role":"user","content":"count"}]}`)
				if got := chatAnswerText(t, chat, stream); got != c.want {
					t.Errorf("chat stream=%t: text %q, want %q", stream, got, c.want)
				}

				if c.resp != "" {
					resp := postOK(t, h, "/v1/responses", `{"model":"claude-haiku-4.5",`+c.resp+`,"stream":`+flag+`,"store":false,"input":"count"}`)
					if got := responsesAnswerText(t, resp, stream); got != c.want {
						t.Errorf("responses stream=%t: text %q, want %q", stream, got, c.want)
					}
				}
			}
		})
	}
}

// Without a stop sequence or max_tokens the stream holds nothing back: every byte after the
// first visible character is sent, trailing space included.
func TestUncutStreamSendsTrailingSpace(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, answerFrame(t, "OK "), answerFrame(t, "\n"), meteringFrame(t))
	})
	streamed := postOK(t, h, "/v1/chat/completions", `{"model":"claude-haiku-4.5","stream":true,"messages":[{"role":"user","content":"x"}]}`)
	if got := chatAnswerText(t, streamed, true); got != "OK \n" {
		t.Errorf("chat streamed text %q, want every byte \"OK \\n\"", got)
	}
	streamed = postOK(t, h, "/v1/messages", `{"model":"claude-haiku-4.5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"x"}]}`)
	if got := claudeStreamText(t, streamed.Body.String()); got != "OK \n" {
		t.Errorf("messages streamed text %q, want every byte \"OK \\n\"", got)
	}
}
