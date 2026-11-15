package proxy

import (
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

// includeWebSearchSources is the Responses include value that adds each search's sources to
// its web_search_call item.
const includeWebSearchSources = "web_search_call.action.sources"

// hostedSearchTally is, for one reply on an OpenAI API, the hosted web searches it ran and
// what the rounds that ended in them spent. The zero value is ready to use.
type hostedSearchTally struct {
	searches []*hostedWebSearch
	// inputTokens and outputTokens sum the rounds that ended in searches.
	inputTokens, outputTokens int
	// addedTokens estimates what the search follow-ups added to the reply's prompt.
	addedTokens int
}

// searchHooks returns the hooks for one reply's hosted searches. Each search is noted in
// t, then passed to onSearch (nil for none). Each round that ended in searches is counted the
// way the Anthropic path counts its rounds: its own prompt, with Kiro's count when it sent one.
func (h *Handler) searchHooks(t *hostedSearchTally, payload *KiroPayload, model string, estimatedInputTokens int, onSearch func(*hostedWebSearch)) *hostedSearchHooks {
	kiroModel := currentMessageModelID(payload)
	return &hostedSearchHooks{
		model: model,
		onSearch: func(search *hostedWebSearch) {
			if !search.done {
				t.searches = append(t.searches, search)
			}
			if onSearch != nil {
				onSearch(search)
			}
		},
		onRound: func(round hostedSearchRound) {
			contextTokens := int(round.contextUsage * float64(getContextWindowSize(model)) / 100.0)
			in, out := h.promptOverheads.finalizeUsage(kiroModel, outputCut{}, round.inputTokens, round.outputTokens, t.promptEstimate(estimatedInputTokens), contextTokens, round.shownTokens+round.callTokens)
			t.inputTokens += in
			//! The round's text is part of the reply's text, which the reply's own count holds.
			t.outputTokens += max(out-round.shownTokens, 0)
			t.addedTokens += round.addedTokens
		},
	}
}

// promptEstimate is the estimate of the prompt the reply's latest round sent.
func (t *hostedSearchTally) promptEstimate(estimatedInputTokens int) int {
	return estimatedInputTokens + t.addedTokens
}

// total adds the rounds that ended in searches to the usage of the reply's last round.
func (t *hostedSearchTally) total(inputTokens, outputTokens int) (int, int) {
	return inputTokens + t.inputTokens, outputTokens + t.outputTokens
}

// webSearchCallItem is a search as a Responses web_search_call output item. Sources are only
// listed when the client asked for them with include, as OpenAI does.
func webSearchCallItem(search *hostedWebSearch, withSources bool) map[string]interface{} {
	status := "in_progress"
	if search.done {
		status = "completed"
		if search.err != nil {
			status = "failed"
		}
	}
	action := map[string]interface{}{"type": "search", "query": search.query, "queries": []string{search.query}}
	if withSources && search.done && search.err == nil {
		sources := make([]map[string]interface{}, 0, len(search.results))
		for _, result := range search.results {
			if result.URL != "" {
				sources = append(sources, map[string]interface{}{"type": "url", "url": result.URL})
			}
		}
		action["sources"] = sources
	}
	return map[string]interface{}{
		"id":     search.id,
		"type":   "web_search_call",
		"status": status,
		"action": action,
	}
}

func responsesIncludes(include []string, value string) bool {
	for _, v := range include {
		if strings.TrimSpace(v) == value {
			return true
		}
	}
	return false
}

// textSpan is a part of a text, [start, end).
type textSpan struct{ start, end int }

// urlCitation is a place where an answer cites a search result. start and end count
// characters (Unicode code points), end exclusive, as text[start:end] slices it in Python.
type urlCitation struct {
	start, end int
	url, title string
}

// searchCitations finds where text cites the results of searches: each markdown link to a
// result's URL, or else the bare URL. The model only sees the results as text, so a URL it
// wrote is the one citation the proxy can place.
func searchCitations(text string, searches []*hostedWebSearch) []urlCitation {
	var found []urlCitation
	var taken []textSpan
	overlaps := func(s textSpan) bool {
		for _, t := range taken {
			if s.start < t.end && t.start < s.end {
				return true
			}
		}
		return false
	}
	seen := make(map[string]bool)
	for _, search := range searches {
		if search == nil || !search.done || search.err != nil {
			continue
		}
		for _, result := range search.results {
			url := strings.TrimSpace(result.URL)
			if url == "" || seen[url] {
				continue
			}
			seen[url] = true
			forms := []string{url}
			if trimmed := strings.TrimSuffix(url, "/"); trimmed != url && trimmed != "" {
				forms = append(forms, trimmed)
			}
			for _, form := range forms {
				for from := 0; ; {
					i := strings.Index(text[from:], form)
					if i < 0 {
						break
					}
					i += from
					end := i + len(form)
					from = end
					if !urlEndsAt(text, end) {
						continue
					}
					s := markdownLinkSpan(text, i, end)
					if overlaps(s) {
						continue
					}
					taken = append(taken, s)
					found = append(found, urlCitation{start: s.start, end: s.end, url: url, title: strings.TrimSpace(result.Title)})
				}
			}
		}
	}
	sort.Slice(found, func(i, j int) bool { return found[i].start < found[j].start })
	for i := range found {
		//! Byte offsets to characters; answers are short, so counting from the start is fine.
		start, end := found[i].start, found[i].end
		found[i].start = utf8.RuneCountInString(text[:start])
		found[i].end = found[i].start + utf8.RuneCountInString(text[start:end])
	}
	return found
}

// urlEndsAt reports whether a URL that ends at byte end of text really ends there, rather than
// being the start of a longer URL. Sentence punctuation after it does not continue it.
func urlEndsAt(text string, end int) bool {
	if end >= len(text) {
		return true
	}
	r, size := utf8.DecodeRuneInString(text[end:])
	switch {
	case unicode.IsLetter(r) || unicode.IsDigit(r):
		return false
	case strings.ContainsRune("/-_~%#=&+@", r):
		return false
	case strings.ContainsRune(".?!,:;", r):
		next, _ := utf8.DecodeRuneInString(text[end+size:])
		return end+size >= len(text) || !(unicode.IsLetter(next) || unicode.IsDigit(next) || next == '/')
	}
	return true
}

// markdownLinkSpan widens the URL at text[start:end] to the markdown link around it,
// [label](url), as OpenAI's citations cover the link; a bare URL keeps its own span.
func markdownLinkSpan(text string, start, end int) textSpan {
	bare := textSpan{start, end}
	if start < 2 || text[start-2:start] != "](" || end >= len(text) || text[end] != ')' {
		return bare
	}
	open := strings.LastIndex(text[:start-2], "[")
	if open < 0 || strings.ContainsAny(text[open:start-2], "\n]") {
		return bare
	}
	return textSpan{open, end + 1}
}

// chatURLAnnotations is citations as a Chat Completions message's annotations.
func chatURLAnnotations(citations []urlCitation) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(citations))
	for _, c := range citations {
		out = append(out, map[string]interface{}{
			"type": "url_citation",
			"url_citation": map[string]interface{}{
				"start_index": c.start,
				"end_index":   c.end,
				"title":       c.title,
				"url":         c.url,
			},
		})
	}
	return out
}

// responsesURLAnnotations is citations as a Responses output_text part's annotations.
func responsesURLAnnotations(citations []urlCitation) []interface{} {
	out := make([]interface{}, 0, len(citations))
	for _, c := range citations {
		out = append(out, map[string]interface{}{
			"type":        "url_citation",
			"start_index": c.start,
			"end_index":   c.end,
			"title":       c.title,
			"url":         c.url,
		})
	}
	return out
}

// buildResponsesSearchOutput lays out a buffered Responses reply that ran hosted searches the
// way the stream sends one: reasoning, then the text before each search, its web_search_call,
// and the text after the last search; client tool calls go last. said[i] is the raw text
// written before search i; rest is the text after the last search.
func buildResponsesSearchOutput(prepared *responsesPreparedRequest, reasoning string, said []string, rest string, stopReason string, searches []*hostedWebSearch, withSources bool, toolUses []KiroToolUse) []map[string]interface{} {
	output := make([]map[string]interface{}, 0, 2+2*len(searches)+len(toolUses))
	if reasoning != "" {
		output = append(output, buildResponsesReasoningOutputItem(reasoning))
	}
	message := func(text string, cited []*hostedWebSearch) {
		output = append(output, buildResponsesMessageItemWithAnnotations("msg_"+uuid.NewString(), text, responsesURLAnnotations(searchCitations(text, cited))))
	}
	for i, search := range searches {
		if i < len(said) {
			if text, _ := splitInlineThinking(said[i]); strings.TrimSpace(text) != "" {
				message(strings.TrimSpace(text), searches[:i])
			}
		}
		output = append(output, webSearchCallItem(search, withSources))
	}
	last, _ := answerFromContent(rest, stopReason)
	if last != "" || len(toolUses) == 0 {
		message(last, searches)
	}
	for _, tu := range toolUses {
		output = append(output, buildPreparedResponsesToolOutputItem(prepared, tu))
	}
	return output
}
