package main

import (
	"encoding/json"
	"io"
	"sync"
)

// protocolVersion is bumped whenever the status lines or the forwarded headers change in a way
// an older proxy would misread. The proxy refuses a helper that speaks another version.
const protocolVersion = 1

// The contract with the proxy (kiro-proxy/tunnel): the env var that carries the shared secret,
// and the headers on every forwarded request.
const (
	secretEnv = "KIRO_TUNNEL_SECRET"
	// headerSecret carries KIRO_TUNNEL_SECRET; the proxy refuses a tunnel request without it.
	headerSecret = "X-Kiro-Tunnel-Secret"
	// headerClient is the visitor's address as ip:port, from the Funnel relay or the tailnet.
	headerClient = "X-Kiro-Tunnel-Client"
)

// States the helper reports, in the order a first run goes through them.
const (
	stateStarting      = "starting"
	stateNeedsLogin    = "needs-login"
	stateNeedsApproval = "needs-approval"
	stateNeedsFunnel   = "needs-funnel"
	stateRunning       = "running"
	stateError         = "error"
)

// Status is one line on stdout. Only the fields of the current state are set.
type Status struct {
	Protocol  int    `json:"protocol"`
	State     string `json:"state"`
	AuthURL   string `json:"authURL,omitempty"`
	EnableURL string `json:"enableURL,omitempty"`
	AdminURL  string `json:"adminURL,omitempty"`
	URL       string `json:"url,omitempty"`
	Error     string `json:"error,omitempty"`
}

// statusWriter writes a line only when the status changed, so a polling loop can call emit every
// second without flooding the proxy.
type statusWriter struct {
	mu   sync.Mutex
	enc  *json.Encoder
	last Status
	sent bool
}

func newStatusWriter(w io.Writer) *statusWriter {
	return &statusWriter{enc: json.NewEncoder(w)}
}

func (s *statusWriter) emit(st Status) {
	st.Protocol = protocolVersion
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sent && st == s.last {
		return
	}
	s.last, s.sent = st, true
	_ = s.enc.Encode(st)
}
