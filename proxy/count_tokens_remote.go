package proxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// The optional external token counter: when Settings names a URL, count_tokens asks it first
// and answers with its count. Any failure (error, timeout, non-2xx, a body without a count)
// falls back to the local estimate, so a down service never fails a client.

// countTokensHopHeader lists the proxies a forwarded count_tokens request went through, as a
// comma-separated list of process IDs. A request that already names this process, or has passed
// countTokensMaxHops proxies, is answered locally, so a URL pointing back at this proxy (or a
// loop through others) cannot recurse. A chain to another proxy with its own counter still works.
const countTokensHopHeader = "X-Kiro-Proxy-Count-Hop"

const countTokensMaxHops = 8

// countTokensHopID names this process in the hop header: random, so no other proxy has it.
var countTokensHopID = newCountTokensHopID()

func newCountTokensHopID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

// countTokensHops reads the hop header. Entries that cannot be a process ID are dropped, so a
// client cannot push arbitrary text through to the external service.
func countTokensHops(h http.Header) []string {
	var hops []string
	for _, value := range h.Values(countTokensHopHeader) {
		for _, entry := range strings.Split(value, ",") {
			entry = strings.TrimSpace(entry)
			if validCountTokensHopID(entry) {
				hops = append(hops, entry)
			}
		}
	}
	return hops
}

func validCountTokensHopID(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// countTokensMaxAnswerBytes caps the external answer; a real one is a few dozen bytes.
const countTokensMaxAnswerBytes = 64 << 10

const defaultAnthropicVersion = "2023-06-01"

// countTokensRemoteTimeout bounds the whole external call, answer included. A var for tests.
var countTokensRemoteTimeout = 5 * time.Second

var (
	countTokensClientOnce sync.Once
	countTokensClient     *http.Client
)

// countTokensRemoteClient does not follow redirects: Go keeps custom headers such as x-api-key
// on a redirect to another host, which would hand the key to it. A 3xx falls back instead.
// It uses the environment's proxy, not the Kiro outbound proxy, which is for AWS traffic.
func countTokensRemoteClient() *http.Client {
	countTokensClientOnce.Do(func() {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = http.ProxyFromEnvironment
		countTokensClient = &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	})
	return countTokensClient
}

// forwardCountTokens asks the external service for the request's input tokens. It reports
// false when no service is set, the request already passed through this proxy, or the call failed
// in any way; the caller then answers with the local estimate. The client's body goes as it
// came, except that the model loses the thinking suffix. Model mappings are not applied: the
// service speaks Anthropic's API and knows Anthropic's model IDs, not Kiro's.
func forwardCountTokens(r *http.Request, body []byte, thinkingSuffix string) (int, bool) {
	settings := config.GetCountTokensSettings()
	if settings.APIURL == "" {
		return 0, false
	}
	host := countTokensURLHost(settings.APIURL)
	hops := countTokensHops(r.Header)
	if slices.Contains(hops, countTokensHopID) {
		logger.Debugf("[CountTokens] request came back to this proxy; using local estimate")
		return 0, false
	}
	if len(hops) >= countTokensMaxHops {
		logger.Debugf("[CountTokens] request passed %d proxies; using local estimate", len(hops))
		return 0, false
	}

	n, err := callCountTokensAPI(r, settings, body, thinkingSuffix, strings.Join(append(hops, countTokensHopID), ","))
	if err != nil {
		if r.Context().Err() != nil {
			// The client left; nothing to report.
			return 0, false
		}
		logger.Warnf("[CountTokens] external failed (host=%s): %v; using local estimate", host, err)
		return 0, false
	}
	logger.Debugf("[CountTokens] external answered %d input tokens (host=%s)", n, host)
	return n, true
}

func callCountTokensAPI(r *http.Request, settings config.CountTokensSettings, body []byte, thinkingSuffix, hops string) (int, error) {
	payload, err := countTokensForwardBody(body, thinkingSuffix)
	if err != nil {
		return 0, err
	}

	ctx, cancel := context.WithTimeout(r.Context(), countTokensRemoteTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, settings.APIURL, bytes.NewReader(payload))
	if err != nil {
		return 0, errors.New("cannot build the request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	version := r.Header.Get("anthropic-version")
	if version == "" {
		version = defaultAnthropicVersion
	}
	req.Header.Set("anthropic-version", version)
	if beta := r.Header.Get("anthropic-beta"); beta != "" {
		req.Header.Set("anthropic-beta", beta)
	}
	req.Header.Set(countTokensHopHeader, hops)
	// Only the configured key goes out, never the key the client sent to this proxy.
	if settings.APIKey != "" {
		if settings.AuthType == config.CountTokensAuthBearer {
			req.Header.Set("Authorization", "Bearer "+settings.APIKey)
		} else {
			req.Header.Set("x-api-key", settings.APIKey)
		}
	}

	resp, err := countTokensRemoteClient().Do(req)
	if err != nil {
		// url.Error repeats the full URL, query included; the cause alone is enough.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, countTokensMaxAnswerBytes))
		return 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, countTokensMaxAnswerBytes+1))
	if err != nil {
		return 0, fmt.Errorf("reading the answer: %w", err)
	}
	if len(data) > countTokensMaxAnswerBytes {
		return 0, fmt.Errorf("answer is larger than %d bytes", countTokensMaxAnswerBytes)
	}
	return parseCountTokensAnswer(data)
}

// countTokensForwardBody is the client's body with the thinking suffix cut from its model
// ("claude-sonnet-4-5-thinking" goes as "claude-sonnet-4-5"); every other field keeps its JSON
// value as the client sent it.
func countTokensForwardBody(body []byte, thinkingSuffix string) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return nil, errors.New("request body is not a JSON object")
	}
	var model string
	if raw, ok := fields["model"]; ok && json.Unmarshal(raw, &model) == nil && thinkingSuffix != "" &&
		len(model) > len(thinkingSuffix) && strings.EqualFold(model[len(model)-len(thinkingSuffix):], thinkingSuffix) {
		stripped, err := json.Marshal(model[:len(model)-len(thinkingSuffix)])
		if err != nil {
			return nil, err
		}
		fields["model"] = stripped
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(fields); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte("\n")), nil
}

// parseCountTokensAnswer reads {"input_tokens": N}; N must be a whole number from 0 up. A 0 is
// answered as 1, like the local estimate.
func parseCountTokensAnswer(data []byte) (int, error) {
	var answer struct {
		InputTokens json.RawMessage `json:"input_tokens"`
	}
	if err := json.Unmarshal(data, &answer); err != nil {
		return 0, errors.New("answer is not a JSON object")
	}
	if len(answer.InputTokens) == 0 || string(answer.InputTokens) == "null" {
		return 0, errors.New("answer has no input_tokens")
	}
	var n int64
	if err := json.Unmarshal(answer.InputTokens, &n); err != nil {
		return 0, errors.New("input_tokens is not a whole number")
	}
	if n < 0 || n > math.MaxInt32 {
		return 0, fmt.Errorf("input_tokens %d is out of range", n)
	}
	return max(int(n), 1), nil
}

// countTokensURLHost is the URL's host for logs; the path and query may carry secrets.
func countTokensURLHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "?"
	}
	return u.Host
}

// maskCountTokensKey shows the last 4 characters of a key of 12 or more, else dots only.
func maskCountTokensKey(key string) string {
	if key == "" {
		return ""
	}
	runes := []rune(key)
	if len(runes) < 12 {
		return "••••"
	}
	return "••••" + string(runes[len(runes)-4:])
}

func countTokensConfigResponse() map[string]interface{} {
	settings := config.GetCountTokensSettings()
	return map[string]interface{}{
		"countTokensApiUrl":       settings.APIURL,
		"countTokensAuthType":     settings.AuthType,
		"countTokensApiKeySet":    settings.APIKey != "",
		"countTokensApiKeyMasked": maskCountTokensKey(settings.APIKey),
	}
}

// apiGetCountTokens answers the external counter's settings. The key is write-only: only
// whether one is saved and its masked tail come back.
func (h *Handler) apiGetCountTokens(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(countTokensConfigResponse())
}

// apiUpdateCountTokens saves the external counter. An omitted field keeps its saved value; an
// empty URL turns the service off and drops the key. An empty or omitted key keeps the saved
// one while the URL stays on the same scheme, host and port, and is dropped when it moves;
// clearApiKey drops it.
func (h *Handler) apiUpdateCountTokens(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIURL   *string `json:"countTokensApiUrl"`
		AuthType *string `json:"countTokensAuthType"`
		APIKey   *string `json:"countTokensApiKey"`
		ClearKey bool    `json:"clearApiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	current := config.GetCountTokensSettings()
	apiURL := current.APIURL
	if req.APIURL != nil {
		apiURL = strings.TrimSpace(*req.APIURL)
	}
	authType := current.AuthType
	if req.AuthType != nil {
		authType = strings.ToLower(strings.TrimSpace(*req.AuthType))
		if authType == "" {
			authType = config.CountTokensAuthXAPIKey
		}
	}

	if apiURL != "" {
		if err := config.ValidateCountTokensURL(apiURL); err != nil {
			writeAdminError(w, http.StatusBadRequest, codeCountTokensURL, err.Error())
			return
		}
		if !config.ValidCountTokensAuthType(authType) {
			writeAdminError(w, http.StatusBadRequest, codeCountTokensAuthType, `countTokensAuthType must be "x-api-key" or "bearer"`)
			return
		}
		if req.APIKey != nil {
			if err := config.ValidateCountTokensKey(strings.TrimSpace(*req.APIKey)); err != nil {
				writeAdminError(w, http.StatusBadRequest, codeCountTokensKey, err.Error())
				return
			}
		}
	}

	if err := config.UpdateCountTokensSettings(apiURL, authType, req.APIKey, req.ClearKey); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}
