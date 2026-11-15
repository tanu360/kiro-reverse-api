package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

//! Kiro moves accounts to CreateResponse by an experiment: GET /featureConfiguration answers
//! {"configuration": {...}} and the create_response_api entry, keyed by a salted hash of the
//! name, says "create_response" for the accounts in it. Such accounts get 429
//! USER_REQUEST_RATE_EXCEEDED on generateAssistantResponse even with credits left. The Kiro
//! IDE (ExperimentConfigService) keeps a configuration 15 minutes per sign-in, reads it within
//! 5 seconds, asks again a minute after a failure, and keeps the last good one meanwhile;
//! without any, the call stays on generateAssistantResponse.

const (
	kiroFeatureConfigSalt   = "kiro-feature-config-key-salt-3e9b1d7a"
	createResponseFlagValue = "create_response"

	chatAPIFlagTTL     = 15 * time.Minute
	chatAPIFlagRetry   = time.Minute
	chatAPIFlagTimeout = 5 * time.Second
	// chatAPIFlagRecheckGap spaces the reads a 429 forces past the cache, per account.
	chatAPIFlagRecheckGap = 30 * time.Second
	maxFeatureConfigBytes = 1 << 20

	chatAPIResponsesName = "CreateResponse (/v1/responses)"
	chatAPILegacyName    = "generateAssistantResponse"
)

// createResponseFeatureKey is create_response_api's key in the feature configuration.
var createResponseFeatureKey = kiroFeatureWireKey("create_response_api")

// kiroFeatureWireKey is the IDE's deriveWireKey: sha256 hex of the salt and the feature name.
func kiroFeatureWireKey(name string) string {
	sum := sha256.Sum256([]byte(kiroFeatureConfigSalt + name))
	return hex.EncodeToString(sum[:])
}

// chatAPIFlag is one account's create_response_api answer.
type chatAPIFlag struct {
	mu sync.Mutex
	// identity hashes the token and profile the answer was read with.
	identity string
	// known says a read succeeded; responses is its answer, kept through later failures.
	known     bool
	responses bool
	// failed says a read failed before any succeeded.
	failed bool
	// until is when the answer goes stale, or, before any answer, when a read may run again.
	until       time.Time
	recheckedAt time.Time
	call        *chatAPIFlagCall
	// lastAPI is the API this account's last request used, for the switch log line.
	lastAPI string
}

// chatAPIFlagCall is one feature configuration read that callers share.
type chatAPIFlagCall struct {
	done      chan struct{}
	responses bool
}

var (
	chatAPIFlags   sync.Map // account key → *chatAPIFlag
	chatAPIFlagNow = time.Now
	// chatAPIFlagFetch reads the flag; tests replace it.
	chatAPIFlagFetch = fetchChatAPIFlag
)

func chatAPIFlagKey(account *config.Account) string {
	if account == nil {
		return ""
	}
	for _, id := range []string{account.ID, account.Email, account.UserId} {
		if id = strings.TrimSpace(id); id != "" {
			return id
		}
	}
	return ""
}

func chatAPIFlagFor(account *config.Account) *chatAPIFlag {
	key := chatAPIFlagKey(account)
	if key == "" {
		return nil
	}
	if f, ok := chatAPIFlags.Load(key); ok {
		return f.(*chatAPIFlag)
	}
	f, _ := chatAPIFlags.LoadOrStore(key, &chatAPIFlag{})
	return f.(*chatAPIFlag)
}

func chatAPIIdentity(account *config.Account, profileArn string) string {
	sum := sha256.Sum256([]byte(accountBearerToken(account) + "\x00" + profileArn))
	return hex.EncodeToString(sum[:8])
}

// useKiroResponsesAPI reports whether this account's chat goes to CreateResponse: the chatApi
// setting, and under auto, Kiro's create_response_api flag for the account. API keys stay on
// the Kiro CLI runtime: the experiment is the IDE's.
func useKiroResponsesAPI(ctx context.Context, account *config.Account, profileArn string) bool {
	if account == nil || config.IsAPIKeyAccount(account) {
		return false
	}
	var responses bool
	switch config.GetChatAPI() {
	case config.ChatAPIResponses:
		responses = true
	case config.ChatAPILegacy:
		responses = false
	default:
		responses = readChatAPIFlag(ctx, account, profileArn, false)
	}
	noteChatAPIUsed(account, responses)
	return responses
}

// recheckKiroResponsesAPI reads the flag again past the cache, at most once per
// chatAPIFlagRecheckGap per account, and reports whether Kiro now routes the account to
// CreateResponse. It is for a 429 USER_REQUEST_RATE_EXCEEDED from generateAssistantResponse.
func recheckKiroResponsesAPI(ctx context.Context, account *config.Account, profileArn string) bool {
	if account == nil || config.IsAPIKeyAccount(account) || config.GetChatAPI() != config.ChatAPIAuto {
		return false
	}
	responses := readChatAPIFlag(ctx, account, profileArn, true)
	if responses {
		noteChatAPIUsed(account, true)
	}
	return responses
}

func readChatAPIFlag(ctx context.Context, account *config.Account, profileArn string, recheck bool) bool {
	f := chatAPIFlagFor(account)
	if f == nil {
		return false
	}
	identity := chatAPIIdentity(account, profileArn)
	now := chatAPIFlagNow()

	f.mu.Lock()
	if f.identity != identity {
		//! A new token or profile is a new sign-in to the IDE: read again, but keep the last
		//! answer meanwhile. The flag belongs to the user, which a token refresh does not change.
		f.identity = identity
		f.until = time.Time{}
	}
	var call *chatAPIFlagCall
	switch {
	case recheck:
		if f.call == nil && !f.recheckedAt.IsZero() && now.Sub(f.recheckedAt) < chatAPIFlagRecheckGap {
			responses := f.known && f.responses
			f.mu.Unlock()
			return responses
		}
		f.recheckedAt = now
		call = f.startLocked(account, profileArn)
	case now.Before(f.until):
		responses := f.known && f.responses
		f.mu.Unlock()
		return responses
	case f.known:
		//! Stale: answer from the last read and refresh it in the background, off the request.
		f.startLocked(account, profileArn)
		responses := f.responses
		f.mu.Unlock()
		return responses
	case f.failed:
		//! Only an account's first read holds up a request; once one failed, the next reads run in
		//! the background, so a feature configuration that keeps failing never slows requests.
		f.startLocked(account, profileArn)
		f.mu.Unlock()
		return false
	default:
		call = f.startLocked(account, profileArn)
	}
	f.mu.Unlock()

	select {
	case <-call.done:
		return call.responses
	case <-ctx.Done():
		return false
	}
}

// startLocked starts a read, or joins the one running. The caller holds f.mu.
func (f *chatAPIFlag) startLocked(account *config.Account, profileArn string) *chatAPIFlagCall {
	if f.call != nil {
		return f.call
	}
	call := &chatAPIFlagCall{done: make(chan struct{})}
	f.call = call
	//! The request is built here, on the caller's goroutine, so the read never touches the
	//! account while a token refresh may be writing it.
	req, err := newChatAPIFlagRequest(account, profileArn)
	client := accountClient(account, false)
	email := accountEmailForLog(account)
	go func() {
		responses := false
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), chatAPIFlagTimeout)
			responses, err = chatAPIFlagFetch(ctx, client, req.WithContext(ctx))
			cancel()
		}
		f.finish(call, responses, err, email)
	}()
	return call
}

func (f *chatAPIFlag) finish(call *chatAPIFlagCall, responses bool, err error, email string) {
	now := chatAPIFlagNow()
	f.mu.Lock()
	if f.call == call {
		f.call = nil
	}
	if err != nil {
		f.until = now.Add(chatAPIFlagRetry)
		f.failed = !f.known
		logger.Debugf("[ChatAPI] Could not read Kiro's feature configuration for %s: %v", email, err)
	} else {
		if !f.known || f.responses != responses {
			logger.Debugf("[ChatAPI] Kiro's create_response_api flag for %s: %t", email, responses)
		}
		f.known = true
		f.failed = false
		f.responses = responses
		f.until = now.Add(chatAPIFlagTTL)
	}
	call.responses = f.known && f.responses
	f.mu.Unlock()
	close(call.done)
}

// noteChatAPIUsed logs one line when an account's chat moves to the other API. The first
// request of an account logs only when it goes to CreateResponse.
func noteChatAPIUsed(account *config.Account, responses bool) {
	f := chatAPIFlagFor(account)
	if f == nil {
		return
	}
	api := chatAPILegacyName
	if responses {
		api = chatAPIResponsesName
	}
	f.mu.Lock()
	prev := f.lastAPI
	f.lastAPI = api
	f.mu.Unlock()
	if prev == api || (prev == "" && !responses) {
		return
	}
	logger.Infof("[ChatAPI] %s now uses Kiro's %s chat API", accountEmailForLog(account), api)
}

// kiroRuntimeHost is the runtime host CreateResponse and the feature configuration live on.
func kiroRuntimeHost(account *config.Account, profileArn string) string {
	return "runtime." + kiroRegionForProfile(account, profileArn) + ".kiro.dev"
}

func newChatAPIFlagRequest(account *config.Account, profileArn string) (*http.Request, error) {
	if profileArn == "" {
		profileArn = requestProfileArn(account)
	}
	host := kiroRuntimeHost(account, profileArn)
	query := url.Values{
		"origin":  {"AI_EDITOR"},
		"version": {config.GetKiroClientConfig().KiroVersion},
	}
	req, err := http.NewRequest(http.MethodGet, "https://"+host+"/featureConfiguration?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	applyKiroBaseHeaders(req, account, buildRuntimeHeaderValues(account, host))
	req.Header.Set("Accept", "application/json")
	//! Builder ID owns no profile, yet the call needs one: the fixed Builder ID profile
	//! (requestProfileArn) answers it, and without any Kiro says 400 "profileArn is required".
	if profileArn != "" {
		req.Header.Set("x-amzn-kiro-profile-arn", profileArn)
	}
	return req, nil
}

// fetchChatAPIFlag reads the feature configuration and reports whether create_response_api
// says "create_response". A missing entry is the control arm.
func fetchChatAPIFlag(_ context.Context, client *http.Client, req *http.Request) (bool, error) {
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamErrorBytes))
		noteKiroVersionGate(string(body))
		return false, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var parsed struct {
		Configuration map[string]json.RawMessage `json:"configuration"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxFeatureConfigBytes)).Decode(&parsed); err != nil {
		return false, fmt.Errorf("decode feature configuration: %w", err)
	}
	raw, ok := parsed.Configuration[createResponseFeatureKey]
	if !ok {
		return false, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		logger.Debugf("[ChatAPI] create_response_api is not a string: %.200s", raw)
		return false, nil
	}
	return value == createResponseFlagValue, nil
}
