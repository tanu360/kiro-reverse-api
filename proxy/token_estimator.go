package proxy

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"strings"
)

//! Image parts used to be estimated as their JSON, so a 200 KB screenshot counted as
//! ~44k tokens and inflated API-key quota reservations. Anthropic bills an image at
//! about width*height/750 tokens and downscales anything larger to ~1600 tokens.

const maxImageTokens = 1600

// estimateImageDataTokens estimates a base64 image from its header dimensions,
// falling back to maxImageTokens when they cannot be read.
func estimateImageDataTokens(data string) int {
	w, h := imageDimensions(data)
	if w <= 0 || h <= 0 {
		return maxImageTokens
	}
	if lim, on := currentImageResizeLimits(); on {
		w, h = fitWithin(w, h, lim.maxDim)
	}
	tokens := int(math.Ceil(float64(w) * float64(h) / 750))
	return min(max(tokens, 1), maxImageTokens)
}

func imageDimensions(data string) (int, int) {
	data = strings.TrimSpace(data)
	if head, err := base64.StdEncoding.DecodeString(data[:min(len(data), 40)]); err == nil {
		if w, h, ok := webpDimensions(head); ok {
			return w, h
		}
	}
	cfg, _, err := image.DecodeConfig(base64.NewDecoder(base64.StdEncoding, strings.NewReader(data)))
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

func webpDimensions(b []byte) (int, int, bool) {
	if len(b) < 30 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return 0, 0, false
	}
	switch string(b[12:16]) {
	case "VP8X":
		return 1 + (int(b[24]) | int(b[25])<<8 | int(b[26])<<16), 1 + (int(b[27]) | int(b[28])<<8 | int(b[29])<<16), true
	case "VP8L":
		bits := binary.LittleEndian.Uint32(b[21:25])
		return 1 + int(bits&0x3FFF), 1 + int(bits>>14&0x3FFF), true
	case "VP8 ":
		return int(binary.LittleEndian.Uint16(b[26:28]) & 0x3FFF), int(binary.LittleEndian.Uint16(b[28:30]) & 0x3FFF), true
	}
	return 0, 0, false
}

func estimateClaudeImageTokens(block map[string]interface{}) int {
	if img := extractImageFromClaudeBlock(block); img != nil {
		return estimateImageDataTokens(img.Source.Bytes)
	}
	return maxImageTokens
}

func isOpenAIImagePart(part map[string]interface{}) bool {
	switch partType, _ := part["type"].(string); partType {
	case "image", "image_url", "input_image":
		return true
	}
	return extractImageFromOpenAIPart(part) != nil
}

// estimateOpenAIImageTokens sums the image parts of OpenAI content and reports
// whether there were any.
func estimateOpenAIImageTokens(content interface{}) (int, bool) {
	var parts []interface{}
	switch value := content.(type) {
	case []interface{}:
		parts = value
	case map[string]interface{}:
		parts = []interface{}{value}
	}
	total, found := 0, false
	for _, p := range parts {
		part, ok := p.(map[string]interface{})
		if !ok || !isOpenAIImagePart(part) {
			continue
		}
		found = true
		if img := extractImageFromOpenAIPart(part); img != nil {
			total += estimateImageDataTokens(img.Source.Bytes)
		} else {
			total += maxImageTokens
		}
	}
	return total, found
}

func estimateApproxTokens(text string) int {
	if text == "" {
		return 0
	}

	runes := []rune(text)
	length := len(runes)
	if length == 0 {
		return 0
	}
	if length < 5 {
		return max(1, int(math.Ceil(float64(length)/3.0)))
	}

	var regularAscii, digits, symbols, nonASCII int
	for _, r := range runes {
		switch {
		case r >= 0x80:
			nonASCII++
		case r >= '0' && r <= '9':
			digits++
		case (r >= '!' && r <= '/') || (r >= ':' && r <= '@') || (r >= '[' && r <= '`') || (r >= '{' && r <= '~'):
			symbols++
		default:
			regularAscii++
		}
	}

	estimated := int(math.Ceil(
		float64(regularAscii)/4.5 +
			float64(digits)/2.0 +
			float64(symbols)/1.5 +
			float64(nonASCII)/1.5,
	))

	if estimated < 1 {
		return 1
	}
	return estimated
}

func estimateClaudeRequestInputTokens(req *ClaudeRequest) int {
	if req == nil {
		return 0
	}

	total := estimateClaudeValueTokens(req.System)

	for _, msg := range req.Messages {
		total += estimateClaudeValueTokens(msg.Content)
	}

	for _, tool := range req.Tools {
		total += estimateApproxTokens(tool.Name)
		total += estimateApproxTokens(tool.Description)
		total += estimateJSONTokens(tool.InputSchema)
	}

	return total
}

func estimateClaudeOutputTokens(content, thinkingContent string, toolUses []KiroToolUse) int {
	total := estimateApproxTokens(content)
	total += estimateApproxTokens(thinkingContent)

	for _, tu := range toolUses {
		total += estimateApproxTokens(tu.Name)
		total += estimateJSONTokens(tu.Input)
	}

	return total
}

func estimateClaudeValueTokens(v interface{}) int {
	switch value := v.(type) {
	case nil:
		return 0
	case string:
		return estimateApproxTokens(value)
	case []interface{}:
		total := 0
		for _, part := range value {
			total += estimateClaudeValueTokens(part)
		}
		return total
	case map[string]interface{}:
		typeName, _ := value["type"].(string)
		switch typeName {
		case "text":
			if text, ok := value["text"].(string); ok {
				return estimateApproxTokens(text)
			}
		case "thinking":
			if thinking, ok := value["thinking"].(string); ok {
				return estimateApproxTokens(thinking)
			}
		case "tool_use":
			total := 0
			if name, ok := value["name"].(string); ok {
				total += estimateApproxTokens(name)
			}
			if input, ok := value["input"]; ok {
				total += estimateJSONTokens(input)
			}
			if total > 0 {
				return total
			}
		case "tool_result":
			if content, ok := value["content"]; ok {
				return estimateClaudeValueTokens(content)
			}
		case "image":
			return estimateClaudeImageTokens(value)
		}

		total := 0
		if text, ok := value["text"].(string); ok {
			total += estimateApproxTokens(text)
		}
		if thinking, ok := value["thinking"].(string); ok {
			total += estimateApproxTokens(thinking)
		}
		if content, ok := value["content"]; ok {
			total += estimateClaudeValueTokens(content)
		}
		if total > 0 {
			return total
		}

		return estimateJSONTokens(value)
	default:
		return estimateJSONTokens(value)
	}
}

func estimateJSONTokens(v interface{}) int {
	if v == nil {
		return 0
	}

	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}

	return estimateApproxTokens(string(b))
}

func estimateOpenAIRequestInputTokens(req *OpenAIRequest) int {
	if req == nil {
		return 0
	}

	total := 0

	for _, msg := range req.Messages {
		total += estimateOpenAIContentTokens(msg.Content)
		total += estimateApproxTokens(msg.ToolCallID)
		for _, tc := range msg.ToolCalls {
			total += estimateApproxTokens(tc.Function.Name)
			total += estimateApproxTokens(tc.Function.Arguments)
		}
	}

	for _, tool := range req.Tools {
		total += estimateApproxTokens(tool.Function.Name)
		total += estimateApproxTokens(tool.Function.Description)
		total += estimateJSONTokens(tool.Function.Parameters)
	}

	return total
}

func estimateOpenAIContentTokens(content interface{}) int {
	switch value := content.(type) {
	case nil:
		return 0
	case string:
		return estimateApproxTokens(value)
	default:
		if imageTokens, ok := estimateOpenAIImageTokens(value); ok {
			text, _ := extractOpenAIUserContent(value)
			return estimateApproxTokens(text) + imageTokens
		}
		text := extractOpenAIMessageText(value)
		if text != "" {
			return estimateApproxTokens(text)
		}
		return estimateJSONTokens(value)
	}
}

func estimateOpenAIOutputTokens(content, reasoningContent string, toolUses []KiroToolUse) int {
	return estimateClaudeOutputTokens(content, reasoningContent, toolUses)
}
