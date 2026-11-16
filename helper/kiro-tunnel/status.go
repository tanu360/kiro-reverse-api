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
	// KeyExpiry (RFC 3339) is when Tailscale signs this device out, while running; empty when
	// the tailnet admin turned key expiry off for it. MachineURL is the device's page in the
	// admin console, where that is done. Older proxies ignore both.
	KeyExpiry  string `json:"keyExpiry,omitempty"`
	MachineURL string `json:"machineURL,omitempty"`
	// Publishing is set while running without a URL once the certificate is in: Funnel is on, and
	// the helper waits for the link to answer from the internet. Older proxies ignore it.
	Publishing bool `json:"publishing,omitempty"`
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
