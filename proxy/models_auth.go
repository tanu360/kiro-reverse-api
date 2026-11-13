package proxy

import "net/http"

// authenticateForModels checks the key for GET /v1/models, which Anthropic and OpenAI
// clients share. Anthropic SDKs and Claude Code send anthropic-version, so they get the
// Anthropic error shape with its top-level "type":"error"; other clients keep the OpenAI one.
func (h *Handler) authenticateForModels(w http.ResponseWriter, r *http.Request) *http.Request {
	if r.Header.Get("anthropic-version") != "" {
		return h.authenticateForClaude(w, r)
	}
	return h.authenticateForOpenAI(w, r)
}
