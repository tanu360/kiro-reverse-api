package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"sort"
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
//! The table is saved in the database, so a cut answer right after a restart reads the same.

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
	// output is the estimated answer the count was taken with. Kiro's count covers prompt and
	// answer, and the answer's estimate runs high on prose (4289 for 3360 live), so a long
	// answer leaves the prompt's count low.
	output  int
	fromCut bool
	seq     uint64
}

// savedPromptOverhead is one entry of the saved table; the list order keeps the age order.
type savedPromptOverhead struct {
	Estimated int  `json:"estimated"`
	Overhead  int  `json:"overhead"`
	Output    int  `json:"output,omitempty"`
	FromCut   bool `json:"fromCut,omitempty"`
}

// promptOverheads remembers, per Kiro model, how far Kiro's prompt count ran past the local
// estimate. A nil *promptOverheads remembers nothing.
type promptOverheads struct {
	mu      sync.Mutex
	seq     uint64
	byModel map[string][]promptOverhead
	// save stores the table after a change; nil keeps it in memory only.
	save   func([]byte) error
	saveMu sync.Mutex
}

func newPromptOverheads() *promptOverheads {
	return &promptOverheads{byModel: map[string][]promptOverhead{}}
}

// loadPromptOverheads returns the table saved in the database, which it keeps saving to.
func loadPromptOverheads() *promptOverheads {
	p := newPromptOverheads()
	p.save = config.SavePromptOverheads
	data, err := config.LoadPromptOverheads()
	if err != nil {
		logger.Warnf("[Usage] Could not load the saved prompt overheads: %v", err)
		return p
	}
	if data == nil {
		return p
	}
	var saved map[string][]savedPromptOverhead
	if err := json.Unmarshal(data, &saved); err != nil {
		logger.Warnf("[Usage] Could not read the saved prompt overheads: %v", err)
		return p
	}
	models := make([]string, 0, len(saved))
	for model := range saved {
		models = append(models, model)
	}
	sort.Strings(models)
	for _, model := range models {
		for _, e := range saved[model] {
			p.record(model, e.Estimated, e.Estimated+e.Overhead, e.Output, e.FromCut)
		}
	}
	return p
}

// persist saves the table; saves run one at a time, each with the table as it is then.
func (p *promptOverheads) persist() {
	if p == nil || p.save == nil {
		return
	}
	p.saveMu.Lock()
	defer p.saveMu.Unlock()
	p.mu.Lock()
	saved := make(map[string][]savedPromptOverhead, len(p.byModel))
	for model, list := range p.byModel {
		ordered := append([]promptOverhead(nil), list...)
		sort.Slice(ordered, func(i, j int) bool { return ordered[i].seq < ordered[j].seq })
		for _, e := range ordered {
			saved[model] = append(saved[model], savedPromptOverhead{Estimated: e.estimated, Overhead: e.overhead, Output: e.output, FromCut: e.fromCut})
		}
	}
	p.mu.Unlock()
	data, err := json.Marshal(saved)
	if err == nil {
		err = p.save(data)
	}
	if err != nil {
		logger.Warnf("[Usage] Could not save the prompt overheads: %v", err)
	}
}

// record notes Kiro's count of a prompt and reports whether the table changed. A whole answer's
// count replaces an earlier one for a prompt of the same estimate; a cut answer's count is only
// kept when there is none.
func (p *promptOverheads) record(model string, estimated, counted, output int, fromCut bool) bool {
	if p == nil || estimated <= 0 || counted <= 0 {
		return false
	}
	key := strings.ToLower(model)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq++
	entry := promptOverhead{estimated: estimated, overhead: counted - estimated, output: max(output, 0), fromCut: fromCut, seq: p.seq}
	list, known := p.byModel[key]
	for i := range list {
		if list[i].estimated == estimated {
			if fromCut && !list[i].fromCut {
				return false
			}
			changed := list[i].overhead != entry.overhead || list[i].output != entry.output || list[i].fromCut != fromCut
			list[i] = entry
			return changed
		}
	}
	if !known && len(p.byModel) >= promptOverheadModels {
		return false
	}
	if len(list) < promptOverheadsPerModel {
		p.byModel[key] = append(list, entry)
		return true
	}
	oldest := 0
	for i := range list {
		if list[i].seq < list[oldest].seq {
			oldest = i
		}
	}
	list[oldest] = entry
	return true
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

// overhead is what Kiro added to the counted prompt that best matches this estimate: of this
// model, else of any model. It is 0 when Kiro has counted no prompt yet.
func (p *promptOverheads) overhead(model string, estimated int) int {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if best, ok := nearestOverhead(p.byModel[strings.ToLower(model)], estimated, true); ok {
		return best.overhead
	}
	var all []promptOverhead
	for _, list := range p.byModel {
		all = append(all, list...)
	}
	//! Another model's prompt of the same size is not the same prompt, so no size wins outright.
	best, _ := nearestOverhead(all, estimated, false)
	return best.overhead
}

// overheadMissPerOutput weighs an entry's answer against its distance in prompt size. Live
// (2026-11-13) Kiro's count grew 0.965 tokens per estimated prompt token, so a size step of d
// misses by about 0.035d, while an answer of n estimated tokens misses by up to 0.25n.
const overheadMissPerOutput = 7

// nearestOverhead picks the entry for a prompt of exactly this estimate when exact is set, else
// the one whose count should miss least: near in size and taken with a short answer. The newest
// wins a tie.
func nearestOverhead(list []promptOverhead, estimated int, exact bool) (promptOverhead, bool) {
	var best promptOverhead
	bestMiss, found := 0, false
	for _, e := range list {
		miss := absInt(e.estimated-estimated) + overheadMissPerOutput*e.output
		if exact && e.estimated == estimated {
			miss = -1
		}
		if !found || miss < bestMiss || (miss == bestMiss && e.seq > best.seq) {
			best, bestMiss, found = e, miss, true
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
		//! Kiro's own input count does not include the answer, so no answer makes it miss.
		if p.record(model, estimatedInputTokens, inputTokens, 0, false) {
			p.persist()
		}
		return inputTokens, outputTokens
	}
	if contextTokens > 0 && !(cut.cut && p.countedWhole(model, estimatedInputTokens)) {
		inputTokens = inputFromContextTokens(contextTokens, outputTokens+cut.unsent, estimatedInputTokens)
		if p.record(model, estimatedInputTokens, inputTokens, outputTokens+cut.unsent, cut.cut) {
			p.persist()
		}
		return inputTokens, outputTokens
	}
	return estimatedInputTokens + p.overhead(model, estimatedInputTokens), outputTokens
}
