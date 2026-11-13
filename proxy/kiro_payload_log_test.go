package proxy

import (
	"bytes"
	"strings"
	"testing"

	"kiro-proxy/logger"
)

// A Claude Code screenshot put about 400 KB of base64 on one debug line.
func TestDebugPayloadLogShortensInlineImages(t *testing.T) {
	keepLogLevel(t)
	var buf bytes.Buffer
	logger.SetOutput(&buf)
	t.Cleanup(logger.ResetOutput)

	image := strings.Repeat("iVBORw0KGgo", 40000)
	payload := testKiroPayload()
	img := KiroImage{Format: "png"}
	img.Source.Bytes = image
	payload.ConversationState.CurrentMessage.UserInputMessage.Images = []KiroImage{img}

	logger.SetLevel(logger.LevelInfo)
	logKiroPayloadDebug(payload)
	if buf.Len() != 0 {
		t.Fatalf("info level wrote %d bytes", buf.Len())
	}

	logger.SetLevel(logger.LevelDebug)
	logKiroPayloadDebug(payload)
	line := buf.String()
	if strings.Contains(line, image[:200]) || !strings.Contains(line, `"bytes":"<440000 base64 chars>"`) || len(line) > 4096 {
		t.Fatalf("debug line (%d bytes): %.300s", len(line), line)
	}
}
