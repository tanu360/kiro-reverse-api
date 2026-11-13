package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"kiro-proxy/config"
)

// requestLogModel is the model a request row names: the one the request runs on after the
// model mappings and the thinking suffix, as its success row would name it.
func requestLogModel(model string) string {
	mapped, _ := ParseModelAndThinking(model, config.GetThinkingConfig().Suffix)
	return mapped
}

// maxRejectedBodyBytes bounds how much of a refused request is read to find its model.
const maxRejectedBodyBytes = 4 << 20

// rejectedRequestModel is the model a request refused before its handler ran (a used-up key, a
// wrong key) asked for, so its request row names the model like every other row does.
func rejectedRequestModel(r *http.Request) string {
	if r == nil || r.Body == nil || r.Method != http.MethodPost {
		return ""
	}
	var body struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxRejectedBodyBytes)).Decode(&body); err != nil {
		return ""
	}
	if strings.TrimSpace(body.Model) == "" {
		return ""
	}
	return requestLogModel(body.Model)
}
