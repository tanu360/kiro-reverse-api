package proxy

import (
	"strings"
	"sync"
)

//! Kiro counts a prompt only through contextUsageEvent, which ends the stream after the whole
//! answer, and its count includes Kiro's own system prompt: live (2026-11-13) a 22-token prompt
//! read 4151 on the Claude models and auto, 3793 on deepseek-3.2 and 3744 on glm-5. The output
//! limiter cancels the stream at max_tokens or a stop sequence, so on a cut answer the count
//! arrived or not depending on timing, and the same prompt read 4151, 4174 or 22. A cut answer
//! now reports what Kiro counted for the prompt: the count it brought, with the output past the
//! cut removed as well, or else the estimate plus what Kiro added to the nearest prompt it
//! counted. A prompt Kiro already counted keeps that count, so it reads the same cut or not.

const (
	// promptOverheadsPerModel bounds the prompt sizes remembered for one model.
	promptOverheadsPerModel = 32
	// promptOverheadModels bounds the models remembered.
	promptOverheadModels = 64
)

// outputCut is what the output limiter reports when it cut an answer: the output Kiro wrote
// past the cut, which never reached the client but is part of Kiro's context count.
type outputCut struct {
	cut    bool
	unsent int
}

func (c *outputCut) record(unsentTokens int) {
	c.cut = true
	c.unsent = max(unsentTokens, 0)
}

type promptOverhead struct {
	estimated int // the local estimate of the prompt
	overhead  int // Kiro's count of the prompt minus the estimate
	fromCut   bool
	seq       uint64
}

// promptOverheads remembers, per Kiro model, how far Kiro's prompt count ran past the local
// estimate. A nil *promptOverheads remembers nothing.
type promptOverheads struct {
	mu      sync.Mutex
	seq     uint64
	byModel map[string][]promptOverhead
}

func newPromptOverheads() *promptOverheads {
	return &promptOverheads{byModel: map[string][]promptOverhead{}}
}

// record notes Kiro's count of a prompt. A whole answer's count replaces an earlier one for a
// prompt of the same estimate; a cut answer's count is only kept when there is none.
func (p *promptOverheads) record(model string, estimated, counted int, fromCut bool) {
	if p == nil || estimated <= 0 || counted <= 0 {
		return
	}
	key := strings.ToLower(model)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq++
	entry := promptOverhead{estimated: estimated, overhead: counted - estimated, fromCut: fromCut, seq: p.seq}
	list, known := p.byModel[key]
	for i := range list {
		if list[i].estimated == estimated {
			if !fromCut || list[i].fromCut {
				list[i] = entry
			}
			return
		}
	}
	if !known && len(p.byModel) >= promptOverheadModels {
		return
	}
	if len(list) < promptOverheadsPerModel {
		p.byModel[key] = append(list, entry)
		return
	}
	oldest := 0
	for i := range list {
		if list[i].seq < list[oldest].seq {
			oldest = i
		}
	}
	list[oldest] = entry
}

// countedWhole reports whether a whole answer brought Kiro's count of a prompt of this estimate.
func (p *promptOverheads) countedWhole(model string, estimated int) bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.byModel[strings.ToLower(model)] {
		if e.estimated == estimated && !e.fromCut {
			return true
		}
	}
	return false
}

// overhead is what Kiro added to the counted prompt nearest in estimated size: of this model,
// else of any model. It is 0 when Kiro has counted no prompt yet.
func (p *promptOverheads) overhead(model string, estimated int) int {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if best, ok := nearestOverhead(p.byModel[strings.ToLower(model)], estimated); ok {
		return best.overhead
	}
	var all []promptOverhead
	for _, list := range p.byModel {
		all = append(all, list...)
	}
	best, _ := nearestOverhead(all, estimated)
	return best.overhead
}

// nearestOverhead picks the entry closest in estimated size; the newest wins a tie.
func nearestOverhead(list []promptOverhead, estimated int) (promptOverhead, bool) {
	var best promptOverhead
	found := false
	for _, e := range list {
		d, bestD := absInt(e.estimated-estimated), absInt(best.estimated-estimated)
		if !found || d < bestD || (d == bestD && e.seq > best.seq) {
			best, found = e, true
		}
	}
	return best, found
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// finalizeUsage fills in the usage of a finished turn. contextTokens comes from
// contextUsagePercentage, which Kiro measures after the turn: the prompt plus the whole answer,
// including any output past a limit cut. Without Kiro's count, and on a cut answer of a prompt
// a whole answer already counted, the input is the estimate plus Kiro's overhead.
func (p *promptOverheads) finalizeUsage(model string, cut outputCut, inputTokens, outputTokens, estimatedInputTokens, contextTokens, estimatedOutputTokens int) (int, int) {
	if outputTokens <= 0 {
		outputTokens = estimatedOutputTokens
	}
	if inputTokens > 0 {
		p.record(model, estimatedInputTokens, inputTokens, false)
		return inputTokens, outputTokens
	}
	if contextTokens > 0 && !(cut.cut && p.countedWhole(model, estimatedInputTokens)) {
		inputTokens = inputFromContextTokens(contextTokens, outputTokens+cut.unsent, estimatedInputTokens)
		p.record(model, estimatedInputTokens, inputTokens, cut.cut)
		return inputTokens, outputTokens
	}
	return estimatedInputTokens + p.overhead(model, estimatedInputTokens), outputTokens
}
