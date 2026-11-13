package proxy

import (
	"context"
	"errors"
	"strings"
	"testing"

	"kiro-proxy/config"
)

// limitedStream plays text chunks like a Kiro stream and stops as soon as its context is
// cancelled, the way an HTTP body read fails once the request context ends.
type limitedStream struct {
	thinking []string
	text     []string
	tools    []KiroToolUse
	err      error
	// sent counts the chunks handed to the callback before the stream ended.
	sent      int
	cancelled bool
}

func (s *limitedStream) call(ctx context.Context, _ *config.Account, _ *KiroPayload, cb *KiroStreamCallback) error {
	for _, chunk := range s.thinking {
		if ctx.Err() != nil {
			s.cancelled = true
			return ctx.Err()
		}
		s.sent++
		cb.OnText(chunk, true)
	}
	for _, chunk := range s.text {
		if ctx.Err() != nil {
			s.cancelled = true
			return ctx.Err()
		}
		s.sent++
		cb.OnText(chunk, false)
	}
	for _, tool := range s.tools {
		if ctx.Err() != nil {
			s.cancelled = true
			return ctx.Err()
		}
		cb.OnToolUse(tool)
	}
	if ctx.Err() != nil {
		s.cancelled = true
		return ctx.Err()
	}
	if s.err != nil {
		return s.err
	}
	cb.OnStopReason("end_turn")
	cb.OnCredits(0.5)
	cb.OnComplete(4100, 999)
	return nil
}

type limitRecorder struct {
	text, thinking string
	tools          []KiroToolUse
	stop           string
	sequence       *string
	in, out        int
	credits        float64
	completed      bool
}

func (r *limitRecorder) callback() *KiroStreamCallback {
	return &KiroStreamCallback{
		OnText: func(text string, isThinking bool) {
			if isThinking {
				r.thinking += text
			} else {
				r.text += text
			}
		},
		OnToolUse:      func(tu KiroToolUse) { r.tools = append(r.tools, tu) },
		OnStopReason:   func(reason string) { r.stop = reason },
		OnStopSequence: func(sequence string) { r.sequence = &sequence },
		OnCredits:      func(c float64) { r.credits = c },
		OnComplete: func(in, out int) {
			r.in, r.out, r.completed = in, out, true
		},
	}
}

func limitPayload(maxTokens int, stops ...string) *KiroPayload {
	payload := &KiroPayload{StopSequences: stops}
	if maxTokens > 0 {
		payload.InferenceConfig = &InferenceConfig{MaxTokens: maxTokens}
	}
	return payload
}

func TestOutputLimitCutsTheAnswerAtMaxTokens(t *testing.T) {
	essay := strings.Repeat("Bridges carry roads over rivers and valleys. ", 40)
	stream := &limitedStream{text: []string{essay[:300], essay[300:900], essay[900:]}}
	rec := &limitRecorder{}
	err := callKiroAutoContinue(context.Background(), nil, limitPayload(100), rec.callback(), stream.call)
	if err != nil {
		t.Fatalf("a reply cut at max_tokens must end without an error, got %v", err)
	}
	if !stream.cancelled {
		t.Fatalf("the upstream stream must be cancelled once the budget is spent")
	}
	if got := estimateApproxTokens(rec.text); got > 100 || got < 95 {
		t.Fatalf("forwarded %d estimated tokens, want close to 100: %q", got, rec.text)
	}
	if !strings.HasPrefix(essay, rec.text) {
		t.Fatalf("the forwarded text must be the start of the answer")
	}
	if rec.stop != "max_tokens" || mapClaudeStopReason(rec.stop, 0) != "max_tokens" || mapOpenAIFinishReason(rec.stop, 0) != "length" {
		t.Fatalf("stop reason = %q, want max_tokens (length on OpenAI)", rec.stop)
	}
	if status, reason := mapResponsesCompletion(rec.stop); status != "incomplete" || reason != "max_output_tokens" {
		t.Fatalf("responses completion = %q/%q", status, reason)
	}
	if !rec.completed || rec.out < 95 || rec.out > 100 {
		t.Fatalf("output tokens = %d (completed %t), want the counted output", rec.out, rec.completed)
	}
}

func TestOutputLimitCountsReasoningTowardMaxTokens(t *testing.T) {
	stream := &limitedStream{
		thinking: []string{strings.Repeat("think about it ", 30)},
		text:     []string{"The answer is 42."},
	}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(50), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if rec.text != "" || rec.stop != "max_tokens" {
		t.Fatalf("reasoning past the budget must end the turn before the answer: text %q stop %q", rec.text, rec.stop)
	}
	if got := estimateApproxTokens(rec.thinking); got > 50 {
		t.Fatalf("forwarded %d reasoning tokens past a budget of 50", got)
	}
}

func TestOutputLimitLeavesShortAnswersAlone(t *testing.T) {
	stream := &limitedStream{text: []string{"OK"}}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(64), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if rec.text != "OK" || rec.stop != "end_turn" || rec.in != 4100 || rec.out != 999 || rec.credits != 0.5 || stream.cancelled {
		t.Fatalf("a reply inside the budget must pass through with Kiro's usage: %+v cancelled=%t", rec, stream.cancelled)
	}
	if rec.sequence != nil {
		t.Fatalf("no stop sequence matched, got %q", *rec.sequence)
	}
}

func TestOutputLimitStopsAtAStopSequenceSplitAcrossChunks(t *testing.T) {
	stream := &limitedStream{text: []string{"ONE TWO THREE FOUR FIVE SIX SE", "VEN EIGHT", " NINE TEN"}}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(200, "SEVEN"), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if rec.text != "ONE TWO THREE FOUR FIVE SIX " {
		t.Fatalf("text = %q, want everything before SEVEN", rec.text)
	}
	if rec.stop != "stop_sequence" || rec.sequence == nil || *rec.sequence != "SEVEN" {
		t.Fatalf("stop = %q sequence = %v, want stop_sequence SEVEN", rec.stop, rec.sequence)
	}
	if !stream.cancelled {
		t.Fatalf("the stream must be cancelled at the stop sequence")
	}
	if claudeStopSequence("stop_sequence", rec.sequence) == nil || claudeStopSequence("end_turn", rec.sequence) != nil {
		t.Fatalf("stop_sequence must be set only with the stop_sequence reason")
	}
	if mapOpenAIFinishReason(rec.stop, 0) != "stop" {
		t.Fatalf("OpenAI finish reason for a stop sequence must be stop")
	}
}

func TestOutputLimitPicksTheEarliestStopSequence(t *testing.T) {
	stream := &limitedStream{text: []string{"1 2 3 4 5 6 7 8 9"}}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(0, "7", "5"), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if rec.text != "1 2 3 4 " || *rec.sequence != "5" {
		t.Fatalf("text %q sequence %q, want the cut before 5", rec.text, *rec.sequence)
	}
}

func TestOutputLimitIgnoresStopSequencesInsideInlineThinking(t *testing.T) {
	stream := &limitedStream{text: []string{"<think", "ing>Count to SEVEN first.</thin", "king>\n\nONE SEVEN TWO"}}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(500, "SEVEN"), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if rec.text != "<thinking>Count to SEVEN first.</thinking>\n\nONE " {
		t.Fatalf("text = %q, want the thinking block whole and the answer cut", rec.text)
	}
}

func TestOutputLimitHoldsNoMoreThanAStopSequenceCanNeed(t *testing.T) {
	var seen []string
	cb := &KiroStreamCallback{OnText: func(text string, _ bool) { seen = append(seen, text) }}
	l := newOutputLimiter(context.Background(), limitPayload(0, "END"), cb)
	l.callback().OnText("hello world, this is a long line", false)
	if strings.Join(seen, "") == "" {
		t.Fatalf("text far from any stop sequence must not wait for the stream end")
	}
	if held := len(l.pending); held > len(inlineThinkingClose)-1 {
		t.Fatalf("held %d bytes, want at most %d", held, len(inlineThinkingClose)-1)
	}
}

func TestOutputLimitNeverSplitsACharacter(t *testing.T) {
	stream := &limitedStream{text: []string{strings.Repeat("桥梁", 200)}}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(25, "停"), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(strings.Repeat("桥梁", 200), rec.text) || strings.ContainsRune(rec.text, '�') {
		t.Fatalf("text %q is not a clean prefix", rec.text)
	}
}

func TestOutputLimitDropsAToolCallAfterTheBudgetIsSpent(t *testing.T) {
	stream := &limitedStream{
		text:  []string{strings.Repeat("word ", 200)},
		tools: []KiroToolUse{{ToolUseID: "t1", Name: "read_file", Input: map[string]interface{}{"path": "a"}}},
	}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(20), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if len(rec.tools) != 0 || rec.stop != "max_tokens" {
		t.Fatalf("tools %v stop %q, want no tool call after the budget", rec.tools, rec.stop)
	}
}

func TestOutputLimitSendsAStartedToolCallWhole(t *testing.T) {
	big := map[string]interface{}{"content": strings.Repeat("x", 4000)}
	stream := &limitedStream{
		text:  []string{"Writing the file."},
		tools: []KiroToolUse{{ToolUseID: "t1", Name: "write_file", Input: big}, {ToolUseID: "t2", Name: "write_file", Input: big}},
	}
	rec := &limitRecorder{}
	if err := callKiroAutoContinue(context.Background(), nil, limitPayload(100), rec.callback(), stream.call); err != nil {
		t.Fatal(err)
	}
	if len(rec.tools) != 1 || rec.tools[0].ToolUseID != "t1" {
		t.Fatalf("tools = %v, want only the call that started inside the budget, whole", rec.tools)
	}
	if mapClaudeStopReason(rec.stop, len(rec.tools)) != "tool_use" {
		t.Fatalf("a turn ending on a whole tool call reads as tool_use")
	}
}

func TestOutputLimitKeepsUpstreamErrorsBeforeOutput(t *testing.T) {
	boom := errors.New("HTTP 500 from Kiro IDE")
	stream := &limitedStream{err: boom}
	rec := &limitRecorder{}
	err := callKiroAutoContinue(context.Background(), nil, limitPayload(100, "STOP"), rec.callback(), stream.call)
	if !errors.Is(err, boom) || rec.completed || rec.text != "" {
		t.Fatalf("err %v completed %t text %q, want the upstream error untouched", err, rec.completed, rec.text)
	}
}

func TestOutputLimitHandsOverHeldTextWhenTheStreamFailsMidAnswer(t *testing.T) {
	boom := errors.New("upstream truncated response")
	stream := &limitedStream{text: []string{"Hello there, friend. ", "Partial ST"}, err: boom}
	rec := &limitRecorder{}
	err := callKiroAutoContinue(context.Background(), nil, limitPayload(100, "STOP"), rec.callback(), stream.call)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if rec.text != "Hello there, friend. Partial ST" {
		t.Fatalf("text = %q, want the held tail handed over before the error", rec.text)
	}
}

func TestOutputLimitIsOffWithoutLimits(t *testing.T) {
	if l := newOutputLimiter(context.Background(), limitPayload(0), &KiroStreamCallback{}); l != nil {
		t.Fatalf("no max_tokens and no stop sequences must not wrap the call")
	}
	ctx := context.WithValue(context.Background(), outputLimitsKey{}, true)
	if l := newOutputLimiter(ctx, limitPayload(10), &KiroStreamCallback{}); l != nil {
		t.Fatalf("an inner call must not apply the limits twice")
	}
}

func TestOpenAIStopSequencesParse(t *testing.T) {
	cases := []struct {
		raw  string
		want []string
		bad  bool
	}{
		{raw: ``, want: nil},
		{raw: `null`, want: nil},
		{raw: `"5"`, want: []string{"5"}},
		{raw: `["a","","b"]`, want: []string{"a", "b"}},
		{raw: `["1","2","3","4","5"]`, bad: true},
		{raw: `7`, bad: true},
	}
	for _, c := range cases {
		got, msg := openAIStopSequences([]byte(c.raw))
		if (msg != "") != c.bad || strings.Join(got, "|") != strings.Join(c.want, "|") {
			t.Fatalf("%s: got %v %q", c.raw, got, msg)
		}
	}
}

func TestOpenAIOutputOptionsRefuseWhatKiroCannotDo(t *testing.T) {
	two, one := 2, 1
	yes, no := true, false
	five := 5
	cases := []struct {
		req  OpenAIRequest
		fail bool
	}{
		{req: OpenAIRequest{N: &one, Logprobs: &no}},
		{req: OpenAIRequest{N: &two}, fail: true},
		{req: OpenAIRequest{Logprobs: &yes}, fail: true},
		{req: OpenAIRequest{TopLogprobs: &five}, fail: true},
		{req: OpenAIRequest{Stop: []byte(`{"x":1}`)}, fail: true},
	}
	for i, c := range cases {
		if got := validateOpenAIOutputOptions(&c.req); (got != "") != c.fail {
			t.Fatalf("case %d: %q", i, got)
		}
	}
	if got := openAIMaxOutputTokens(&OpenAIRequest{MaxTokens: 50, MaxCompletionTokens: 8}); got != 8 {
		t.Fatalf("max_completion_tokens must win, got %d", got)
	}
	if got := openAIMaxOutputTokens(&OpenAIRequest{MaxTokens: 50}); got != 50 {
		t.Fatalf("max_tokens alone, got %d", got)
	}
}
