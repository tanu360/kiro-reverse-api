package proxy

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func TestClassifyRequestClient(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{"claude code cli", map[string]string{"User-Agent": "claude-cli/2.1.325 (external, cli)", "X-App": "cli"}, requestClientClaudeCode},
		{"claude code without x-app", map[string]string{"User-Agent": "claude-cli/1.0.58 (external, cli)"}, requestClientClaudeCode},
		{"claude agent sdk", map[string]string{"User-Agent": "claude-cli/2.0.14 (external, sdk-ts, agent-sdk/0.1.30)"}, requestClientClaudeCode},
		{"claude code x-app only", map[string]string{"User-Agent": "Anthropic/JS 0.54.0", "X-App": "cli"}, requestClientClaudeCode},
		{"claude code background session", map[string]string{"X-App": "cli-bg"}, requestClientClaudeCode},
		{"codex cli", map[string]string{"User-Agent": "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464", "Originator": "codex_cli_rs"}, requestClientCodex},
		{"codex exec", map[string]string{"User-Agent": "codex_exec/0.46.0 (Ubuntu 24.4.0; x86_64) xterm-256color (codex_exec; 0.46.0)"}, requestClientCodex},
		{"codex vscode", map[string]string{"User-Agent": "codex_vscode/0.153.2 (Windows 10.0.26100; x86_64) unknown"}, requestClientCodex},
		{"codex tui", map[string]string{"User-Agent": "codex-tui/0.170.0 (Debian 13.0.0; x86_64) WindowsTerminal"}, requestClientCodex},
		{"codex desktop", map[string]string{"User-Agent": "Codex Desktop/0.170.0 (Mac OS 26.1.0; arm64)"}, requestClientCodex},
		{"codex originator only", map[string]string{"User-Agent": "reqwest/0.12", "Originator": "codex_sdk_ts"}, requestClientCodex},
		{"opencode 1", map[string]string{"User-Agent": "opencode/1.3.4 ai-sdk/provider-utils/3.0.12 runtime/bun/1.2.23"}, requestClientOpencode},
		{"opencode 2", map[string]string{"User-Agent": "opencode/latest/2.3.0/cli"}, requestClientOpencode},
		{"opencode client header", map[string]string{"User-Agent": "ai-sdk/anthropic/2.0.30", "X-Opencode-Client": "cli"}, requestClientOpencode},
		{"opencode originator is not codex", map[string]string{"User-Agent": "OpenAI/JS 5.10.1", "Originator": "opencode"}, ""},
		{"cline", map[string]string{"User-Agent": "Cline/3.38.0", "X-Title": "Cline", "HTTP-Referer": "https://cline.bot"}, requestClientCline},
		{"cline title only", map[string]string{"User-Agent": "OpenAI/JS 4.96.0", "X-Title": "Cline"}, requestClientCline},
		{"roo code", map[string]string{"User-Agent": "RooCode/3.30.1", "X-Title": "Roo Code"}, requestClientRooCode},
		{"kilo code", map[string]string{"User-Agent": "Kilo-Code/4.120.0", "X-Title": "Kilo Code"}, requestClientKiloCode},
		{"kilo cli", map[string]string{"User-Agent": "kilo/latest/7.8.8/cli ai-sdk/provider-utils/4.0.46 runtime/bun/1.4.2"}, requestClientKiloCode},
		{"anthropic sdk default", map[string]string{"User-Agent": "Anthropic/Python 0.69.0"}, ""},
		{"openai sdk default", map[string]string{"User-Agent": "OpenAI/JS 5.10.1"}, ""},
		{"curl", map[string]string{"User-Agent": "curl/8.7.1"}, ""},
		{"a name that only contains a tool", map[string]string{"User-Agent": "my-claude-cli/1.0"}, ""},
		{"other app", map[string]string{"X-App": "desktop"}, ""},
		{"no headers", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			header := http.Header{}
			for name, value := range tt.headers {
				header.Set(name, value)
			}
			if got := classifyRequestClient(header); got != tt.want {
				t.Fatalf("classifyRequestClient(%v) = %q, want %q", tt.headers, got, tt.want)
			}
		})
	}
}

func TestRequestLogKeepsClientNotUserAgent(t *testing.T) {
	resetObservePersistenceForTest(t)
	dir := tempDataDir(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatal(err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatal(err)
	}
	const agent = "claude-cli/2.1.325 (external, cli)"
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("User-Agent", agent)
	req = withRequestTrace(req, requestEndpointClaude)
	s := getObserveStore()
	s.RecordTracedRequest(requestTraceFromContext(req.Context()), "acc", "", "", "a@example.com", "m", 10, 2, 0.1, true, 200, "")
	s.RecordTracedRequest(nil, "acc", "", "", "a@example.com", "m", 10, 2, 0.1, true, 200, "")

	if mem := s.RecentRequests(2); len(mem) != 2 || mem[0].Client != "" || mem[1].Client != requestClientClaudeCode {
		t.Fatalf("memory records = %+v", mem)
	}
	page, err := queryPersistedRequests(requestQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Requests) != 2 || page.Requests[0].Client != "" || page.Requests[1].Client != requestClientClaudeCode {
		t.Fatalf("persisted page = %+v", page.Requests)
	}
	loaded, err := loadRecentRequestsFromDB(2)
	if err != nil || len(loaded) != 2 || loaded[1].Client != requestClientClaudeCode {
		t.Fatalf("loaded = %+v err=%v", loaded, err)
	}
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	var leaked int
	if err := d.QueryRow(`SELECT COUNT(*) FROM requests WHERE client LIKE '%claude-cli%' OR message LIKE '%claude-cli%'`).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("the User-Agent must not be stored: rows=%d err=%v", leaked, err)
	}
}
