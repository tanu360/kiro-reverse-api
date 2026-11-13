package proxy

import (
	"fmt"
	"net/http"
	"strings"
)

// errorShape is the error body a client API path answers in.
type errorShape int

const (
	errorShapeOpenAI errorShape = iota
	errorShapeAnthropic
	// errorShapeByHeader is for the paths both SDKs call (/v1/models): anthropic-version picks.
	errorShapeByHeader
)

// methodNotAllowedText is the 405 message: the method used and the ones the path takes.
func methodNotAllowedText(r *http.Request, allowed []string) string {
	use := strings.Join(allowed, " or ")
	return fmt.Sprintf("%s is not allowed on %s. Use %s.", r.Method, r.URL.Path, use)
}

// sendMethodNotAllowed answers a method a client API path does not take with a JSON 405 in the
// path's API shape, an Allow header and X-Should-Retry: false, so SDKs show the message at once.
func sendMethodNotAllowed(w http.ResponseWriter, r *http.Request, shape errorShape, allowed ...string) {
	allow := make([]string, 0, len(allowed)+1)
	for _, method := range allowed {
		allow = append(allow, method)
		if method == http.MethodGet {
			//! Every GET path also answers HEAD.
			allow = append(allow, http.MethodHead)
		}
	}
	w.Header().Set("Allow", strings.Join(allow, ", "))
	message := methodNotAllowedText(r, allowed)
	switch shape {
	case errorShapeAnthropic:
		(&Handler{}).sendClaudeError(w, http.StatusMethodNotAllowed, "invalid_request_error", message)
	case errorShapeByHeader:
		sendModelsError(w, r, http.StatusMethodNotAllowed, "invalid_request_error", message)
	default:
		(&Handler{}).sendOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", message)
	}
}

// refuseMethod answers 405 when r's method is not one of allowed, and reports whether it did.
// The inference paths, which keep a request log, log the refusal there.
func refuseMethod(w http.ResponseWriter, r *http.Request, shape errorShape, allowed ...string) bool {
	for _, method := range allowed {
		//! HEAD is GET without the body; net/http drops the body itself.
		if r.Method == method || (r.Method == http.MethodHead && method == http.MethodGet) {
			return false
		}
	}
	if requestTraceFromContext(r.Context()) != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyIDFromContext(r.Context()), apiKeyValueFromContext(r.Context()),
			nil, "", 0, 0, 0, false, http.StatusMethodNotAllowed, methodNotAllowedText(r, allowed))
	}
	sendMethodNotAllowed(w, r, shape, allowed...)
	return true
}
