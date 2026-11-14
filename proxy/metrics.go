package proxy

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/proxypool"
)

// metricsDurationBuckets are the request latency histogram's upper bounds, in seconds.
var metricsDurationBuckets = []float64{0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300}

type requestSeries struct{ outcome, status, model, account, apiKey string }
type tokenSeries struct{ kind, model, account, apiKey string }
type usageSeries struct{ model, account, apiKey string }
type durationSeries struct{ endpoint, outcome string }
type errorSeries struct{ category, account string }

type histogram struct {
	counts []uint64
	sum    float64
	count  uint64
}

// metricsRegistry counts what /metrics reports since the server started. The
// gauges (account states, proxy health) are read at scrape time instead.
type metricsRegistry struct {
	mu        sync.Mutex
	requests  map[requestSeries]uint64
	tokens    map[tokenSeries]uint64
	credits   map[usageSeries]float64
	durations map[durationSeries]*histogram
	errors    map[errorSeries]uint64
}

var metrics = newMetricsRegistry()

func newMetricsRegistry() *metricsRegistry {
	return &metricsRegistry{
		requests:  map[requestSeries]uint64{},
		tokens:    map[tokenSeries]uint64{},
		credits:   map[usageSeries]float64{},
		durations: map[durationSeries]*histogram{},
		errors:    map[errorSeries]uint64{},
	}
}

// metricsAccount labels an account by its email, or its id when it has none.
func metricsAccount(accountID, email string) string {
	if email != "" {
		return email
	}
	if accountID != "" {
		return accountID
	}
	return "none"
}

func metricsLabel(value string) string {
	if value == "" {
		return "none"
	}
	return value
}

// recordRequestMetrics counts one logged client request.
func recordRequestMetrics(rec requestRecord) {
	outcome := "failed"
	if rec.Success {
		outcome = "success"
	}
	account := metricsAccount(rec.AccountID, rec.Email)
	apiKey := metricsLabel(rec.APIKeyID)
	model := metricsLabel(rec.Model)
	endpoint := metricsLabel(rec.Endpoint)
	m := metrics
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[requestSeries{outcome, strconv.Itoa(rec.Status), model, account, apiKey}]++
	for kind, n := range map[string]int{"input": rec.InTokens, "output": rec.OutTokens, "cache_read": rec.CacheRead, "cache_write": rec.CacheWrite} {
		if n > 0 {
			m.tokens[tokenSeries{kind, model, account, apiKey}] += uint64(n)
		}
	}
	if rec.Credits > 0 {
		m.credits[usageSeries{model, account, apiKey}] += rec.Credits
	}
	key := durationSeries{endpoint, outcome}
	h := m.durations[key]
	if h == nil {
		h = &histogram{counts: make([]uint64, len(metricsDurationBuckets))}
		m.durations[key] = h
	}
	seconds := float64(rec.DurationMs) / 1000
	for i, bound := range metricsDurationBuckets {
		if seconds <= bound {
			h.counts[i]++
		}
	}
	h.sum += seconds
	h.count++
}

// recordUpstreamErrorMetric counts one failed upstream attempt by its category, the
// request log's error types.
func recordUpstreamErrorMetric(accountID, email string, status int, message string) {
	recordUpstreamErrorCategory(accountID, email, classifyRequestError(false, status, message))
}

// recordAttemptErrorMetric is recordUpstreamErrorMetric for an attempt's error: one that
// failed at an outbound proxy counts as a proxy error, as the attempt timeline files it,
// even when Go's text names no proxy.
func recordAttemptErrorMetric(account *config.Account, status int, err error) {
	if account == nil || err == nil {
		return
	}
	if _, atProxy := proxyFailureOf(account, err); atProxy {
		recordUpstreamErrorCategory(account.ID, account.Email, errorTypeProxy)
		return
	}
	recordUpstreamErrorMetric(account.ID, account.Email, status, err.Error())
}

func recordUpstreamErrorCategory(accountID, email, category string) {
	m := metrics
	m.mu.Lock()
	m.errors[errorSeries{category, metricsAccount(accountID, email)}]++
	m.mu.Unlock()
}

// labelValue escapes a label value for the Prometheus text format.
func labelValue(v string) string {
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, "\n", `\n`)
	return strings.ReplaceAll(v, `"`, `\"`)
}

func labels(pairs ...string) string {
	var b strings.Builder
	b.WriteByte('{')
	for i := 0; i+1 < len(pairs); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(pairs[i])
		b.WriteString(`="`)
		b.WriteString(labelValue(pairs[i+1]))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

func formatFloat(v float64) string {
	if math.IsInf(v, 1) {
		return "+Inf"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

type metricsWriter struct {
	b strings.Builder
}

func (w *metricsWriter) family(name, kind, help string) {
	fmt.Fprintf(&w.b, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
}

func (w *metricsWriter) sample(name, lbls string, value string) {
	w.b.WriteString(name)
	w.b.WriteString(lbls)
	w.b.WriteByte(' ')
	w.b.WriteString(value)
	w.b.WriteByte('\n')
}

func sortedKeys[K comparable](m map[K]struct{}, less func(a, b K) bool) []K {
	keys := make([]K, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return less(keys[i], keys[j]) })
	return keys
}

// render writes the whole exposition: counters from the registry, then the
// gauges read now.
func (h *Handler) renderMetrics() string {
	w := &metricsWriter{}
	m := metrics
	m.mu.Lock()
	requests := make(map[requestSeries]uint64, len(m.requests))
	for k, v := range m.requests {
		requests[k] = v
	}
	tokens := make(map[tokenSeries]uint64, len(m.tokens))
	for k, v := range m.tokens {
		tokens[k] = v
	}
	credits := make(map[usageSeries]float64, len(m.credits))
	for k, v := range m.credits {
		credits[k] = v
	}
	durations := make(map[durationSeries]histogram, len(m.durations))
	for k, v := range m.durations {
		durations[k] = histogram{counts: append([]uint64(nil), v.counts...), sum: v.sum, count: v.count}
	}
	upstream := make(map[errorSeries]uint64, len(m.errors))
	for k, v := range m.errors {
		upstream[k] = v
	}
	m.mu.Unlock()

	w.family("kiro_build_info", "gauge", "Version of the running server.")
	w.sample("kiro_build_info", labels("version", config.Version), "1")
	w.family("kiro_uptime_seconds", "gauge", "Seconds since the server started.")
	w.sample("kiro_uptime_seconds", "", strconv.FormatInt(time.Now().Unix()-h.startTime, 10))

	w.family("kiro_requests_total", "counter", "Client requests by outcome, HTTP status, model, account and API key id.")
	reqKeys := make(map[requestSeries]struct{}, len(requests))
	for k := range requests {
		reqKeys[k] = struct{}{}
	}
	for _, k := range sortedKeys(reqKeys, func(a, b requestSeries) bool {
		return fmt.Sprint(a) < fmt.Sprint(b)
	}) {
		w.sample("kiro_requests_total", labels("outcome", k.outcome, "status", k.status, "model", k.model, "account", k.account, "api_key", k.apiKey), strconv.FormatUint(requests[k], 10))
	}

	w.family("kiro_tokens_total", "counter", "Tokens by kind (input, output, cache_read, cache_write), model, account and API key id.")
	tokKeys := make(map[tokenSeries]struct{}, len(tokens))
	for k := range tokens {
		tokKeys[k] = struct{}{}
	}
	for _, k := range sortedKeys(tokKeys, func(a, b tokenSeries) bool { return fmt.Sprint(a) < fmt.Sprint(b) }) {
		w.sample("kiro_tokens_total", labels("kind", k.kind, "model", k.model, "account", k.account, "api_key", k.apiKey), strconv.FormatUint(tokens[k], 10))
	}

	w.family("kiro_credits_total", "counter", "Kiro credits used by model, account and API key id.")
	credKeys := make(map[usageSeries]struct{}, len(credits))
	for k := range credits {
		credKeys[k] = struct{}{}
	}
	for _, k := range sortedKeys(credKeys, func(a, b usageSeries) bool { return fmt.Sprint(a) < fmt.Sprint(b) }) {
		w.sample("kiro_credits_total", labels("model", k.model, "account", k.account, "api_key", k.apiKey), formatFloat(credits[k]))
	}

	w.family("kiro_request_duration_seconds", "histogram", "Client request latency by API and outcome.")
	durKeys := make(map[durationSeries]struct{}, len(durations))
	for k := range durations {
		durKeys[k] = struct{}{}
	}
	for _, k := range sortedKeys(durKeys, func(a, b durationSeries) bool { return fmt.Sprint(a) < fmt.Sprint(b) }) {
		hist := durations[k]
		for i, bound := range metricsDurationBuckets {
			w.sample("kiro_request_duration_seconds_bucket", labels("endpoint", k.endpoint, "outcome", k.outcome, "le", formatFloat(bound)), strconv.FormatUint(hist.counts[i], 10))
		}
		w.sample("kiro_request_duration_seconds_bucket", labels("endpoint", k.endpoint, "outcome", k.outcome, "le", "+Inf"), strconv.FormatUint(hist.count, 10))
		w.sample("kiro_request_duration_seconds_sum", labels("endpoint", k.endpoint, "outcome", k.outcome), formatFloat(hist.sum))
		w.sample("kiro_request_duration_seconds_count", labels("endpoint", k.endpoint, "outcome", k.outcome), strconv.FormatUint(hist.count, 10))
	}

	w.family("kiro_upstream_errors_total", "counter", "Failed upstream attempts by error category and account.")
	errKeys := make(map[errorSeries]struct{}, len(upstream))
	for k := range upstream {
		errKeys[k] = struct{}{}
	}
	for _, k := range sortedKeys(errKeys, func(a, b errorSeries) bool { return fmt.Sprint(a) < fmt.Sprint(b) }) {
		w.sample("kiro_upstream_errors_total", labels("category", k.category, "account", k.account), strconv.FormatUint(upstream[k], 10))
	}

	h.renderAccountMetrics(w)
	renderProxyMetrics(w)
	return w.b.String()
}

// accountMetricState is one account's state as /metrics names it.
func (h *Handler) accountMetricState(a config.Account, allowOverUsage bool) string {
	switch {
	case !a.Enabled:
		return "disabled"
	case a.Silent || (a.BanStatus != "" && a.BanStatus != "ACTIVE"):
		return "banned"
	case h.pool != nil && time.Now().Before(h.pool.CooldownUntil(a.ID)):
		return "cooldown"
	case a.UsageLimit > 0 && a.UsageCurrent >= a.UsageLimit && !allowOverUsage && !strings.EqualFold(a.OverageStatus, "ENABLED"):
		return "over_limit"
	default:
		return "active"
	}
}

var accountMetricStates = []string{"active", "cooldown", "over_limit", "banned", "disabled"}

func (h *Handler) renderAccountMetrics(w *metricsWriter) {
	accounts := config.GetAccounts()
	allowOverUsage := config.GetAllowOverUsage()
	counts := map[string]int{}
	w.family("kiro_account_state", "gauge", "1 for each account's current state: active, cooldown, over_limit, banned or disabled.")
	for _, a := range accounts {
		state := h.accountMetricState(a, allowOverUsage)
		counts[state]++
		w.sample("kiro_account_state", labels("account", metricsAccount(a.ID, a.Email), "state", state), "1")
	}
	w.family("kiro_accounts", "gauge", "Accounts in each state.")
	for _, state := range accountMetricStates {
		w.sample("kiro_accounts", labels("state", state), strconv.Itoa(counts[state]))
	}
	w.family("kiro_account_usage_ratio", "gauge", "Each account's credit usage over its limit, from the last refresh.")
	for _, a := range accounts {
		if a.UsageLimit > 0 {
			w.sample("kiro_account_usage_ratio", labels("account", metricsAccount(a.ID, a.Email)), formatFloat(a.UsageCurrent/a.UsageLimit))
		}
	}
}

func renderProxyMetrics(w *metricsWriter) {
	view := proxypool.Default().View()
	type proxySample struct {
		name, kind, state string
		health            proxypool.Health
	}
	var samples []proxySample
	for _, p := range view.Proxies {
		samples = append(samples, proxySample{proxypool.Name(config.PoolProxy{Label: p.Label, URL: p.URL}), "pool", p.State, p.Health})
	}
	for _, d := range view.Detected {
		name := d.URL
		if d.Username != "" {
			name += " (" + d.Username + ")"
		}
		samples = append(samples, proxySample{name, "detected", d.State, d.Health})
	}
	w.family("kiro_proxy_state", "gauge", "1 for each outbound proxy's state: healthy, unknown, unhealthy, auto_disabled or off. kind is pool or detected.")
	for _, p := range samples {
		w.sample("kiro_proxy_state", labels("proxy", p.name, "kind", p.kind, "state", p.state), "1")
	}
	w.family("kiro_proxy_failures", "gauge", "Failed checks or connections in a row for each outbound proxy.")
	for _, p := range samples {
		w.sample("kiro_proxy_failures", labels("proxy", p.name, "kind", p.kind), strconv.Itoa(p.health.Failures))
	}
	w.family("kiro_proxy_latency_seconds", "gauge", "Latency of each outbound proxy's last passing health check.")
	for _, p := range samples {
		if p.health.LatencyMs > 0 {
			w.sample("kiro_proxy_latency_seconds", labels("proxy", p.name, "kind", p.kind), formatFloat(float64(p.health.LatencyMs)/1000))
		}
	}
	w.family("kiro_proxies", "gauge", "Outbound proxies in each state, pool and detected together.")
	for _, pair := range []struct {
		state string
		n     int
	}{{"healthy", view.Counts.Healthy}, {"unhealthy", view.Counts.Unhealthy}, {"auto_disabled", view.Counts.AutoDisabled}, {"off", view.Counts.Off}, {"unknown", view.Counts.Unknown}} {
		w.sample("kiro_proxies", labels("state", pair.state), strconv.Itoa(pair.n))
	}
}

// handleMetrics serves GET /metrics: 404 while it is off, 401 without the bearer token.
func (h *Handler) handleMetrics(w http.ResponseWriter, r *http.Request) {
	settings := config.GetMetricsSettings()
	if !settings.Enabled || settings.Token == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	supplied, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(supplied)), []byte(settings.Token)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="kiro-proxy metrics"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write([]byte(h.renderMetrics()))
}

// apiMetricsSettings serves /admin/api/metrics: GET reads the switch and token,
// POST {"enabled": bool, "regenerate": bool} changes them.
func (h *Handler) apiMetricsSettings(w http.ResponseWriter, r *http.Request) {
	settings := config.GetMetricsSettings()
	if r.Method == http.MethodPost {
		var req struct {
			Enabled    *bool `json:"enabled"`
			Regenerate bool  `json:"regenerate"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
			writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
			return
		}
		updated, err := config.UpdateMetricsSettings(req.Enabled, req.Regenerate)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		settings = updated
		publishEvent(eventSettingsChanged, "metrics")
	}
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"enabled": settings.Enabled, "token": settings.Token, "path": "/metrics"})
}
