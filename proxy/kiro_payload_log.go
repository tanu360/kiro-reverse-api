package proxy

import (
	"encoding/json"
	"fmt"
	"regexp"

	"kiro-proxy/logger"
)

// payloadInlineBytes matches the base64 of an inline image or document in a Kiro payload.
var payloadInlineBytes = regexp.MustCompile(`"bytes":"[A-Za-z0-9+/=]{64,}"`)

// logKiroPayloadDebug writes the request payload at debug level, and does no work otherwise.
// Inline image and document bytes are replaced by their length: one screenshot is hundreds of
// KB of base64 on a single line, and the debug log needs only its size.
func logKiroPayloadDebug(payload *KiroPayload) {
	if logger.GetLevel() > logger.LevelDebug {
		return
	}
	//! Full payload logging stays debug-only because it can include user prompts and tokens.
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return
	}
	logger.Debugf("[KiroAPI] Request payload: %s", shortenPayloadBytes(payloadJSON))
}

func shortenPayloadBytes(payloadJSON []byte) []byte {
	return payloadInlineBytes.ReplaceAllFunc(payloadJSON, func(match []byte) []byte {
		//! The match is `"bytes":"` (9 bytes), the base64, then a closing quote.
		return []byte(fmt.Sprintf(`"bytes":"<%d base64 chars>"`, len(match)-10))
	})
}
