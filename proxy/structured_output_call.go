package proxy

import (
	"context"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"strings"
)

// callKiroStructured runs a request that asked for JSON output. callKiroAutoContinue sends
// every payload carrying a spec here; the upstream calls run on a copy without it.
func callKiroStructured(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback, call kiroCallFunc) error {
	spec := payload.StructuredOutput
	inner := *payload
	inner.StructuredOutput = nil
	if spec.Stream {
		return callKiroStructuredStream(ctx, account, &inner, callback, call)
	}

	first := &structuredAttempt{downstream: callback, forwardThinking: true}
	if err := callKiroAutoContinue(ctx, account, &inner, first.callback(), call); err != nil {
		//! Nothing but reasoning reached the handler, so its own retry logic still applies.
		return err
	}
	first.flush()
	maxTokens := requestedMaxTokens(&inner)
	if len(first.toolUses) > 0 {
		//! A tool call is not the final answer; the turn reaches the client unchanged.
		finishStructured(callback, maxTokens, first, first.answer.String(), first)
		return nil
	}

	firstCheck := checkStructuredAnswer(first.answer.String(), spec)
	if firstCheck.valid || !first.canRetry(&inner) || ctx.Err() != nil {
		if !firstCheck.valid {
			logger.Infof("[StructuredOutput] Answer did not match the requested JSON (%d problems); no retry possible", len(firstCheck.errs))
		}
		finishStructured(callback, maxTokens, first, firstCheck.best(first.answer.String()), first)
		return nil
	}

	logger.Infof("[StructuredOutput] Answer did not match the requested JSON (%d problems), retrying once", len(firstCheck.errs))
	base := &inner
	if first.followup != nil {
		//! Search results live only in the follow-up payload; retrying from the request would drop them.
		base = first.followup
	}
	retry := &structuredAttempt{downstream: callback}
	err := callKiroAutoContinue(ctx, account, structuredRetryPayload(base, spec, first.answer.String(), firstCheck.errs), retry.callback(), call)
	if err != nil {
		if isContextCanceledError(err) || ctx.Err() != nil {
			return err
		}
		logger.Warnf("[StructuredOutput] Retry failed, keeping the first answer: %v", err)
		finishStructured(callback, maxTokens, first, firstCheck.best(first.answer.String()), first, retry)
		return nil
	}
	retry.flush()
	if len(retry.toolUses) > 0 {
		logger.Warnf("[StructuredOutput] Retry called a tool instead of answering; keeping the first answer")
		finishStructured(callback, maxTokens, first, firstCheck.best(first.answer.String()), first, retry)
		return nil
	}

	retryCheck := checkStructuredAnswer(retry.answer.String(), spec)
	logger.Infof("[StructuredOutput] Retry answer valid=%t", retryCheck.valid)
	//! Best first: the retry's JSON (checked or not), then the first answer's, then the retry's text.
	switch {
	case retryCheck.found:
		finishStructured(callback, maxTokens, retry, retryCheck.text, first, retry)
	case firstCheck.found:
		finishStructured(callback, maxTokens, first, firstCheck.text, first, retry)
	default:
		finishStructured(callback, maxTokens, retry, retryCheck.best(retry.answer.String()), first, retry)
	}
	return nil
}

type structuredCheck struct {
	// text is the extracted JSON when found.
	text  string
	found bool
	valid bool
	errs  []string
}

func checkStructuredAnswer(answer string, spec *structuredOutputSpec) structuredCheck {
	text, found := extractStructuredJSON(answer, spec)
	if !found {
		problem := "no valid JSON value found in the reply"
		if spec.Kind == structuredOutputJSONObject {
			problem = "no valid JSON object found in the reply"
		}
		return structuredCheck{errs: []string{problem}}
	}
	check := structuredCheck{text: text, found: true}
	if spec.Schema != nil {
		value, _ := decodeJSONNumbers(text)
		steps := maxSchemaSteps
		var complete bool
		check.errs, complete = validateJSONSchemaWithin(value, spec.Schema, spec.Strict, &steps)
		if !complete {
			logger.Warnf("[StructuredOutput] JSON schema too costly to check in %d steps; the rest of the answer is unchecked", maxSchemaSteps)
		}
	}
	check.valid = len(check.errs) == 0
	return check
}

// best is what the client gets when no retry improves on this answer.
func (c structuredCheck) best(answer string) string {
	if c.found {
		return c.text
	}
	if inner, ok := stripOuterFence(strings.TrimSpace(answer)); ok {
		return inner
	}
	return answer
}

// structuredAttempt buffers one upstream answer so it can be checked before the client sees it.
type structuredAttempt struct {
	downstream *KiroStreamCallback
	// forwardThinking sends reasoning on at once; a retry's reasoning is dropped.
	forwardThinking bool
	splitter        thinkingTagSplitter
	answer          strings.Builder
	thinking        strings.Builder
	toolUses        []KiroToolUse
	followup        *KiroPayload
	stopReason      string
	inputTokens     int
	outputTokens    int
	credits         float64
	cacheRead       int
	cacheWrite      int
	contextUsage    float64
}

func (a *structuredAttempt) callback() *KiroStreamCallback {
	cb := *a.downstream
	cb.OnText = func(text string, isThinking bool) {
		if isThinking {
			a.recordThinking(text)
			return
		}
		//! Inline <thinking> blocks are reasoning, not part of the JSON answer.
		a.splitter.Push(text, a.recordAnswer, a.recordThinking)
	}
	if !a.forwardThinking {
		//! A retry's reasoning is dropped, so its signature and redacted blocks go too: they
		//! would sign the first attempt's thinking text with the retry's signature.
		cb.OnThinkingSignature = nil
		cb.OnRedactedThinking = nil
	}
	cb.OnToolUse = func(toolUse KiroToolUse) { a.toolUses = append(a.toolUses, toolUse) }
	cb.onFollowupPayload = func(payload *KiroPayload) { a.followup = payload }
	cb.OnStopReason = func(reason string) { a.stopReason = reason }
	cb.OnCredits = func(credits float64) { a.credits += credits }
	cb.OnContextUsage = func(percentage float64) { a.contextUsage = percentage }
	cb.OnCacheUsage = func(read, write int) { a.cacheRead, a.cacheWrite = read, write }
	cb.OnComplete = func(inputTokens, outputTokens int) {
		a.inputTokens, a.outputTokens = inputTokens, outputTokens
	}
	return &cb
}

func (a *structuredAttempt) recordAnswer(text string) {
	a.answer.WriteString(text)
}

func (a *structuredAttempt) recordThinking(text string) {
	a.thinking.WriteString(text)
	if a.forwardThinking && a.downstream.OnText != nil {
		a.downstream.OnText(text, true)
	}
}

func (a *structuredAttempt) flush() {
	a.splitter.Flush(a.recordAnswer, a.recordThinking)
}

// canRetry rules out answers a retry cannot fix: one cut at the output cap would be cut again.
func (a *structuredAttempt) canRetry(payload *KiroPayload) bool {
	return !isOutputCapStopReason(inferMaxTokensStop(a.stopReason, a.outputTokens, requestedMaxTokens(payload)))
}

// finishStructured hands the chosen answer to the handler with usage summed over every attempt.
func finishStructured(callback *KiroStreamCallback, maxTokens int, used *structuredAttempt, text string, attempts ...*structuredAttempt) {
	if text != "" && callback.OnText != nil {
		callback.OnText(text, false)
	}
	if callback.OnToolUse != nil {
		for _, toolUse := range used.toolUses {
			callback.OnToolUse(toolUse)
		}
	}
	totalIn, totalOut := 0, 0
	totalCredits, totalContext := 0.0, 0.0
	totalCacheRead, totalCacheWrite := 0, 0
	usedOut := used.outputTokens
	for _, attempt := range attempts {
		out := attempt.outputTokens
		if out <= 0 && len(attempts) > 1 {
			//! With no count from Kiro the handler estimates output from the final text alone,
			//! which would leave the discarded attempt unbilled.
			out = estimateApproxTokens(attempt.answer.String() + attempt.thinking.String())
		}
		if attempt == used {
			usedOut = out
		}
		totalIn += attempt.inputTokens
		totalOut += out
		totalCredits += attempt.credits
		totalContext += attempt.contextUsage
		totalCacheRead += attempt.cacheRead
		totalCacheWrite += attempt.cacheWrite
	}
	stopReason := used.stopReason
	if len(attempts) > 1 && strings.TrimSpace(stopReason) == "" {
		//! IdC / Enterprise accounts send no stop reason, and the handler would read summed
		//! output at the cap as a cut-off. Only the used attempt's own output says that.
		stopReason = inferMaxTokensStop("", usedOut, maxTokens)
		if stopReason == "" {
			stopReason = "end_turn"
		}
	}
	if callback.OnStopReason != nil {
		callback.OnStopReason(stopReason)
	}
	if callback.OnCredits != nil && totalCredits > 0 {
		callback.OnCredits(totalCredits)
	}
	if callback.OnContextUsage != nil && totalContext > 0 {
		callback.OnContextUsage(totalContext)
	}
	if callback.OnCacheUsage != nil && totalCacheRead+totalCacheWrite > 0 {
		callback.OnCacheUsage(totalCacheRead, totalCacheWrite)
	}
	if callback.OnComplete != nil {
		callback.OnComplete(totalIn, totalOut)
	}
}

// structuredRetryPayload replays the turn with the rejected answer and asks for a corrected one.
func structuredRetryPayload(base *KiroPayload, spec *structuredOutputSpec, badAnswer string, problems []string) *KiroPayload {
	if strings.TrimSpace(badAnswer) == "" {
		badAnswer = "(empty reply)"
	}
	next := buildContinuationPayload(base, badAnswer, 0)
	next.StructuredOutput = nil
	next.ConversationState.CurrentMessage.UserInputMessage.Content = structuredRetryPrompt(spec, problems)
	return next
}

func structuredRetryPrompt(spec *structuredOutputSpec, problems []string) string {
	var b strings.Builder
	b.WriteString("Your previous reply did not match the required JSON output")
	if len(problems) > 0 {
		b.WriteString(": ")
		b.WriteString(strings.Join(problems, "; "))
	}
	b.WriteString(".\n")
	switch {
	case spec.Schema != nil:
		b.WriteString("Reply again with only the corrected JSON value that matches the JSON schema in the instructions")
	case spec.Kind == structuredOutputJSONObject:
		b.WriteString("Reply again with only one valid JSON object")
	default:
		b.WriteString("Reply again with only one valid JSON value")
	}
	b.WriteString(": no markdown code fences, no explanation, no other text.")
	return b.String()
}

// callKiroStructuredStream streams the answer as it arrives, minus a leading ```json fence.
func callKiroStructuredStream(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback, call kiroCallFunc) error {
	stripper := &jsonFenceStripper{}
	emit := func(text string) {
		if text != "" && callback.OnText != nil {
			callback.OnText(text, false)
		}
	}
	flush := func() { emit(stripper.Flush()) }
	cb := *callback
	cb.OnText = func(text string, isThinking bool) {
		if isThinking {
			if callback.OnText != nil {
				callback.OnText(text, true)
			}
			return
		}
		emit(stripper.Push(text))
	}
	if callback.OnToolUse != nil {
		cb.OnToolUse = func(toolUse KiroToolUse) {
			flush()
			callback.OnToolUse(toolUse)
		}
	}
	if callback.OnStopReason != nil {
		cb.OnStopReason = func(reason string) {
			flush()
			callback.OnStopReason(reason)
		}
	}
	if callback.OnComplete != nil {
		cb.OnComplete = func(inputTokens, outputTokens int) {
			flush()
			callback.OnComplete(inputTokens, outputTokens)
		}
	}
	err := callKiroAutoContinue(ctx, account, payload, &cb, call)
	if err == nil {
		flush()
	}
	return err
}

type fenceState int

const (
	fenceStart fenceState = iota
	fenceThinking
	fenceBody
	fencePass
)

// jsonFenceStripper drops a leading ```json (or bare ```) fence line and its closing ``` line
// from streamed text. Anything else at the start switches it to plain pass-through. Inline
// <thinking> blocks before the answer pass through untouched.
type jsonFenceStripper struct {
	state fenceState
	buf   string
	// midLine is set once part of the current body line was sent; a fence only starts a line.
	midLine bool
}

// maxFenceLineLen bounds how long a first line is held while it could still be a fence.
const maxFenceLineLen = 32

func (s *jsonFenceStripper) Push(text string) string {
	if text == "" {
		return ""
	}
	if s.state == fencePass {
		return text
	}
	s.buf += text
	return s.drain(false)
}

func (s *jsonFenceStripper) Flush() string {
	return s.drain(true)
}

func (s *jsonFenceStripper) drain(final bool) string {
	var out strings.Builder
	for {
		switch s.state {
		case fencePass:
			out.WriteString(s.buf)
			s.buf = ""
			return out.String()

		case fenceThinking:
			if idx := strings.Index(s.buf, thinkingCloseTag); idx >= 0 {
				end := idx + len(thinkingCloseTag)
				out.WriteString(s.buf[:end])
				s.buf = s.buf[end:]
				s.state = fenceStart
				continue
			}
			keep := 0
			if !final {
				keep = partialTagSuffixLen(s.buf, thinkingCloseTag)
			}
			out.WriteString(s.buf[:len(s.buf)-keep])
			s.buf = s.buf[len(s.buf)-keep:]
			return out.String()

		case fenceStart:
			lead := strings.TrimLeft(s.buf, " \t\r\n")
			switch {
			case lead == "":
				if final {
					out.WriteString(s.buf)
					s.buf = ""
				}
				return out.String()
			case strings.HasPrefix(lead, thinkingOpenTag):
				end := strings.Index(s.buf, thinkingOpenTag) + len(thinkingOpenTag)
				out.WriteString(s.buf[:end])
				s.buf = s.buf[end:]
				s.state = fenceThinking
				continue
			case strings.HasPrefix(thinkingOpenTag, lead) && !final:
				return out.String()
			case strings.HasPrefix(lead, "```"):
				newline := strings.IndexByte(lead, '\n')
				if newline < 0 {
					if final || len(lead) > maxFenceLineLen {
						s.state = fencePass
						continue
					}
					return out.String()
				}
				if !isJSONFenceLine(lead[:newline]) {
					s.state = fencePass
					continue
				}
				s.buf = lead[newline+1:]
				s.state = fenceBody
				continue
			case strings.HasPrefix("```", lead) && !final:
				return out.String()
			default:
				s.state = fencePass
				continue
			}

		case fenceBody:
			for {
				newline := strings.IndexByte(s.buf, '\n')
				if newline < 0 {
					break
				}
				if !s.midLine && strings.TrimSpace(s.buf[:newline]) == "```" {
					//! The closing fence; whatever follows it is passed on as written.
					s.buf = s.buf[newline+1:]
					s.state = fencePass
					break
				}
				out.WriteString(s.buf[:newline+1])
				s.buf = s.buf[newline+1:]
				s.midLine = false
			}
			if s.state != fenceBody {
				continue
			}
			if final {
				if s.midLine || strings.TrimSpace(s.buf) != "```" {
					out.WriteString(s.buf)
				}
				s.buf = ""
				return out.String()
			}
			if !s.midLine && strings.Trim(s.buf, "` \t\r") == "" {
				//! Hold a line start that may still become the closing fence.
				return out.String()
			}
			if s.buf != "" {
				out.WriteString(s.buf)
				s.midLine = true
			}
			s.buf = ""
			return out.String()
		}
	}
}

func isJSONFenceLine(line string) bool {
	lang := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "```"))
	return lang == "" || strings.EqualFold(lang, "json")
}
