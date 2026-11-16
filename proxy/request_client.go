package proxy

import (
	"net/http"
	"strings"
)

// The coding tools the request log tells apart. Only this id is kept, never the User-Agent: it
// carries the caller's OS, terminal and versions.
const (
	requestClientClaudeCode = "claude-code"
	requestClientCodex      = "codex"
	requestClientOpencode   = "opencode"
	requestClientCline      = "cline"
	requestClientRooCode    = "roo-code"
	requestClientKiloCode   = "kilo-code"
)

// requestClientAgents maps the product token a tool's User-Agent starts with (lowercased) to
// the tool. SDK defaults ("Anthropic/JS", "OpenAI/Python", "ai-sdk/...") are shared by many
// tools, so they are never matched.
var requestClientAgents = []struct{ prefix, client string }{
	// claude-cli/2.1.3 (external, cli); the Agent SDKs run the same CLI (sdk-ts, sdk-py).
	{"claude-cli/", requestClientClaudeCode},
	// The Codex originators: codex_cli_rs/, codex_exec/, codex_vscode/, codex-tui/, "Codex Desktop/".
	{"codex_", requestClientCodex},
	{"codex-", requestClientCodex},
	{"codex desktop/", requestClientCodex},
	// opencode/1.3.4, or opencode/latest/2.3.0/cli from opencode 2.
	{"opencode/", requestClientOpencode},
	{"cline/", requestClientCline},
	{"roocode/", requestClientRooCode},
	// Kilo-Code/4.2.0 to OpenAI-compatible APIs, kilo/latest/7.8.8/cli to Anthropic ones.
	{"kilo-code/", requestClientKiloCode},
	{"kilo/", requestClientKiloCode},
}

// requestClientTitles maps the X-Title some tools send with an SDK's default User-Agent.
var requestClientTitles = map[string]string{
	"cline":     requestClientCline,
	"roo code":  requestClientRooCode,
	"kilo code": requestClientKiloCode,
}

// classifyRequestClient names the coding tool that sent a request, from its User-Agent and the
// few headers a tool adds of its own; "" when nothing names one the proxy knows.
func classifyRequestClient(header http.Header) string {
	agent := strings.ToLower(strings.TrimSpace(header.Get("User-Agent")))
	for _, known := range requestClientAgents {
		if strings.HasPrefix(agent, known.prefix) {
			return known.client
		}
	}
	// Claude Code marks its API calls with x-app: cli (cli-bg for a background session).
	if app := strings.ToLower(strings.TrimSpace(header.Get("X-App"))); app == "cli" || app == "cli-bg" {
		return requestClientClaudeCode
	}
	// Match the originator's value: opencode and Cline send the header too, with their own names.
	if originator := strings.ToLower(strings.TrimSpace(header.Get("Originator"))); strings.HasPrefix(originator, "codex") {
		return requestClientCodex
	}
	if client, ok := requestClientTitles[strings.ToLower(strings.TrimSpace(header.Get("X-Title")))]; ok {
		return client
	}
	if header.Get("X-Opencode-Client") != "" {
		return requestClientOpencode
	}
	return ""
}
