package proxy

import (
	"encoding/base64"
	"fmt"
	"path"
	"strings"
)

const toolResultDocumentPlaceholder = "[Tool returned a document; the document is attached to this message.]"

const documentOnlyUserContent = "Please analyze the attached document."

type KiroDocument struct {
	Format string `json:"format"`
	Name   string `json:"name"`
	Source struct {
		Bytes string `json:"bytes"`
	} `json:"source"`
}

var documentFormatsByMediaType = map[string]string{
	"application/pdf":    "pdf",
	"text/csv":           "csv",
	"text/html":          "html",
	"text/markdown":      "md",
	"text/plain":         "txt",
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}

// extractDocuments collects inline documents (Anthropic "document", OpenAI
// "file"/"input_file"), including ones a tool_result returned. Image files stay
// on the image path; hosted file IDs, URLs and unknown formats are skipped.
func extractDocuments(content interface{}) []KiroDocument {
	docs := collectDocuments(content)
	//! Upstream document names must be unique within a message.
	seen := make(map[string]int, len(docs))
	for i := range docs {
		base := docs[i].Name
		seen[base]++
		if n := seen[base]; n > 1 {
			docs[i].Name = fmt.Sprintf("%s (%d)", base, n)
		}
	}
	return docs
}

func collectDocuments(content interface{}) []KiroDocument {
	blocks, ok := content.([]interface{})
	if !ok {
		return nil
	}
	var docs []KiroDocument
	for _, b := range blocks {
		block, ok := b.(map[string]interface{})
		if !ok {
			continue
		}
		switch kind, _ := block["type"].(string); kind {
		case "tool_result":
			docs = append(docs, collectDocuments(block["content"])...)
		case "document", "file", "input_file":
			if extractImageFromOpenAIPart(block) != nil {
				continue
			}
			if doc := kiroDocumentFromBlock(block); doc != nil {
				docs = append(docs, *doc)
			}
		}
	}
	return docs
}

func kiroDocumentFromBlock(block map[string]interface{}) *KiroDocument {
	name := firstString(block["title"], block["filename"], block["name"])
	var media, data string
	if source, ok := block["source"].(map[string]interface{}); ok {
		switch firstString(source["type"]) {
		case "base64":
			media, data = firstString(source["media_type"]), firstString(source["data"])
		case "text":
			media = "text/plain"
			data = base64.StdEncoding.EncodeToString([]byte(firstString(source["data"])))
		default:
			return nil
		}
	}
	if file, ok := block["file"].(map[string]interface{}); ok {
		if name == "" {
			name = firstString(file["filename"])
		}
		if data == "" {
			data = firstString(file["file_data"])
		}
	}
	if data == "" {
		data = firstString(block["file_data"])
	}
	if strings.HasPrefix(data, "data:") {
		header, encoded, ok := strings.Cut(strings.TrimPrefix(data, "data:"), ",")
		if !ok || !strings.HasSuffix(header, ";base64") {
			return nil
		}
		media, _, _ = strings.Cut(header, ";")
		data = encoded
	}
	if data == "" {
		return nil
	}
	if _, err := base64.StdEncoding.DecodeString(data); err != nil {
		return nil
	}

	format := documentFormatsByMediaType[strings.ToLower(strings.TrimSpace(media))]
	if format == "" {
		ext := strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
		for _, known := range documentFormatsByMediaType {
			if ext == known {
				format = known
				break
			}
		}
	}
	if format == "" {
		return nil
	}

	doc := &KiroDocument{Format: format, Name: kiroDocumentName(name)}
	doc.Source.Bytes = data
	return doc
}

// kiroDocumentName keeps only the characters the upstream accepts in document
// names: ASCII letters and digits, single spaces, hyphens, parentheses, brackets.
func kiroDocumentName(name string) string {
	mapped := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case strings.ContainsRune("-()[]", r):
			return r
		}
		return ' '
	}, name)
	cleaned := strings.Join(strings.Fields(mapped), " ")
	if len(cleaned) > 100 {
		cleaned = strings.TrimSpace(cleaned[:100])
	}
	if cleaned == "" {
		return "document"
	}
	return cleaned
}
