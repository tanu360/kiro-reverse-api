package proxy

import "strings"

const (
	thinkingOpenTag  = "<thinking>"
	thinkingCloseTag = "</thinking>"
)

//! Kiro has no native reasoning channel for the Responses API; thinking arrives inline
//! as <thinking>...</thinking> inside the normal assistant text stream. Tags can be split
//! across chunks, so the splitter holds back only the buffer suffix that could still grow
//! into a tag and releases everything else immediately.
type thinkingTagSplitter struct {
	buf     string
	inBlock bool
}

//! Push feeds one upstream chunk; onText receives visible answer text and onThinking
//! receives reasoning text, both already stripped of the tags themselves.
func (s *thinkingTagSplitter) Push(text string, onText, onThinking func(string)) {
	if text == "" {
		return
	}
	s.buf += text
	s.drain(false, onText, onThinking)
}

//! Flush releases whatever is buffered once the upstream stream ends. An unterminated
//! thinking block is treated as reasoning so a truncated tag never leaks into the answer.
func (s *thinkingTagSplitter) Flush(onText, onThinking func(string)) {
	s.drain(true, onText, onThinking)
}

func (s *thinkingTagSplitter) drain(final bool, onText, onThinking func(string)) {
	for {
		tag, sink := thinkingOpenTag, onText
		if s.inBlock {
			tag, sink = thinkingCloseTag, onThinking
		}
		if idx := strings.Index(s.buf, tag); idx != -1 {
			emitSplit(sink, s.buf[:idx])
			s.buf = s.buf[idx+len(tag):]
			s.inBlock = !s.inBlock
			continue
		}
		if final {
			emitSplit(sink, s.buf)
			s.buf = ""
			return
		}
		keep := len(s.buf) - partialTagSuffixLen(s.buf, tag)
		if keep > 0 {
			emitSplit(sink, s.buf[:keep])
			s.buf = s.buf[keep:]
		}
		return
	}
}

func emitSplit(sink func(string), text string) {
	if text != "" && sink != nil {
		sink(text)
	}
}

//! partialTagSuffixLen reports how many trailing bytes of s form a proper prefix of tag,
//! i.e. the bytes that must stay buffered because they may complete the tag next chunk.
//! Tags are ASCII, so cutting before them never splits a multi-byte rune.
func partialTagSuffixLen(s, tag string) int {
	maxLen := len(tag) - 1
	if maxLen > len(s) {
		maxLen = len(s)
	}
	for k := maxLen; k > 0; k-- {
		if strings.HasSuffix(s, tag[:k]) {
			return k
		}
	}
	return 0
}
