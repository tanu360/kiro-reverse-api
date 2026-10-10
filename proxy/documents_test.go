package proxy

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

var testPDFBase64 = base64.StdEncoding.EncodeToString([]byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n"))

const testPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

func TestClaudeDocumentBlocksReachKiro(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 1024, Messages: []ClaudeMessage{
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "document", "title": "Q3_report.final.pdf", "source": map[string]interface{}{"type": "base64", "media_type": "application/pdf", "data": testPDFBase64}},
			map[string]interface{}{"type": "document", "source": map[string]interface{}{"type": "text", "media_type": "text/plain", "data": "plain notes"}},
			map[string]interface{}{"type": "document", "source": map[string]interface{}{"type": "url", "url": "https://example.com/a.pdf"}},
			map[string]interface{}{"type": "document", "title": "a.zip", "source": map[string]interface{}{"type": "base64", "media_type": "application/zip", "data": testPDFBase64}},
			map[string]interface{}{"type": "text", "text": "Summarize."},
		}},
	}}
	payload := ClaudeToKiro(req, false)
	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if cur.Content != "Summarize." {
		t.Fatalf("content = %q", cur.Content)
	}
	if len(cur.Documents) != 2 || len(cur.Images) != 0 {
		t.Fatalf("documents = %#v, images = %d, want pdf and text documents only", cur.Documents, len(cur.Images))
	}
	if doc := cur.Documents[0]; doc.Format != "pdf" || doc.Name != "Q3 report final pdf" || doc.Source.Bytes != testPDFBase64 {
		t.Fatalf("pdf document = %#v", doc)
	}
	text, _ := base64.StdEncoding.DecodeString(cur.Documents[1].Source.Bytes)
	if doc := cur.Documents[1]; doc.Format != "txt" || doc.Name != "document" || string(text) != "plain notes" {
		t.Fatalf("text document = %#v", doc)
	}
}

func TestDocumentNamesAreUniqueWithinMessage(t *testing.T) {
	block := map[string]interface{}{"type": "document", "title": "a.pdf", "source": map[string]interface{}{"type": "base64", "media_type": "application/pdf", "data": testPDFBase64}}
	docs := extractDocuments([]interface{}{block, block, block})
	var names []string
	for _, doc := range docs {
		names = append(names, doc.Name)
	}
	if strings.Join(names, "|") != "a pdf|a pdf (2)|a pdf (3)" {
		t.Fatalf("names = %v", names)
	}
}

func TestDocumentOnlyClaudeMessageIsAccepted(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 1024, Messages: []ClaudeMessage{
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "document", "source": map[string]interface{}{"type": "base64", "media_type": "application/pdf", "data": testPDFBase64}},
		}},
	}}
	if msg := validateClaudeRequestShape(req); msg != "" {
		t.Fatalf("document-only message rejected: %s", msg)
	}
	cur := ClaudeToKiro(req, false).ConversationState.CurrentMessage.UserInputMessage
	if cur.Content != documentOnlyUserContent || len(cur.Documents) != 1 {
		t.Fatalf("content=%q documents=%d", cur.Content, len(cur.Documents))
	}
}

func TestClaudeToolResultDocumentIsAttached(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 1024,
		Tools: []ClaudeTool{{Name: "Read", InputSchema: map[string]interface{}{"type": "object"}}},
		Messages: []ClaudeMessage{
			{Role: "user", Content: "read the pdf"},
			{Role: "assistant", Content: []interface{}{map[string]interface{}{"type": "tool_use", "id": "call1", "name": "Read", "input": map[string]interface{}{}}}},
			{Role: "user", Content: []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "call1", "content": []interface{}{
				map[string]interface{}{"type": "document", "source": map[string]interface{}{"type": "base64", "media_type": "application/pdf", "data": testPDFBase64}},
			}}}},
		}}
	cur := ClaudeToKiro(req, false).ConversationState.CurrentMessage.UserInputMessage
	if len(cur.Documents) != 1 || cur.Documents[0].Format != "pdf" || len(cur.Images) != 0 {
		t.Fatalf("documents = %#v, images = %d", cur.Documents, len(cur.Images))
	}
	ctx := cur.UserInputMessageContext
	if ctx == nil || len(ctx.ToolResults) != 1 || ctx.ToolResults[0].Content[0].Text != toolResultDocumentPlaceholder {
		t.Fatalf("tool result = %#v", ctx)
	}
}

func TestOpenAIFilePartsReachKiro(t *testing.T) {
	md := base64.StdEncoding.EncodeToString([]byte("# Notes"))
	req := &OpenAIRequest{Model: "claude-sonnet-4.5", Messages: []OpenAIMessage{
		{Role: "user", Content: []interface{}{
			map[string]interface{}{"type": "file", "file": map[string]interface{}{"filename": "notes.md", "file_data": "data:text/markdown;base64," + md}},
			map[string]interface{}{"type": "input_file", "filename": "spec.pdf", "file_data": "data:application/pdf;base64," + testPDFBase64},
			map[string]interface{}{"type": "file", "file": map[string]interface{}{"filename": "shot.png", "file_data": "data:image/png;base64," + testPNGBase64}},
			map[string]interface{}{"type": "file", "file": map[string]interface{}{"file_id": "file-abc"}},
			map[string]interface{}{"type": "text", "text": "Compare them."},
		}},
	}}
	cur := OpenAIToKiro(req, false).ConversationState.CurrentMessage.UserInputMessage
	//! The image file and the hosted file_id are not documents.
	if len(cur.Documents) != 2 || cur.Documents[0].Format != "md" || cur.Documents[0].Name != "notes md" || cur.Documents[1].Format != "pdf" {
		t.Fatalf("documents = %#v", cur.Documents)
	}
}

func TestPayloadWithoutDocumentsKeepsShape(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 1024, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}
	raw, err := json.Marshal(ClaudeToKiro(req, false))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"documents"`) {
		t.Fatalf("documents key sent without documents: %s", raw)
	}
}
