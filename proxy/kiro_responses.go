package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/proxypool"
	"kiro-proxy/textfmt"
)

const (
	// kiroResponsesEndpointName names CreateResponse in attempts and logs.
	kiroResponsesEndpointName = "Kiro Responses"
	// kiroAgentServiceVersion is the Kiro IDE agent (KAS) build its CreateResponse user agent names.
	kiroAgentServiceVersion = "0.66.102-hotfix.1"
	// kiroResponsesIDEAttempts is the retry budget the IDE states in x-amzn-kiro-attempt.
	kiroResponsesIDEAttempts = 3
)

// kiroResponsesURL is CreateResponse on the account's runtime: the profile ARN's region, else
// the account's, else us-east-1 (the apiRegion override wins, as for every Kiro call).
func kiroResponsesURL(account *config.Account, profileArn string) string {
	return "https://" + kiroRuntimeHost(account, profileArn) + "/v1/responses"
}

// kiroResponsesUserAgent is the IDE's plain HTTP user agent for CreateResponse (not the AWS
// SDK's): "KiroIDE <version> <machine id> KAS/<agent version> acp-client/kiro-ide".
func kiroResponsesUserAgent(account *config.Account) string {
	parts := []string{"KiroIDE", config.GetKiroClientConfig().KiroVersion}
	if account != nil && strings.TrimSpace(account.MachineId) != "" {
		parts = append(parts, strings.TrimSpace(account.MachineId))
	}
	return strings.Join(parts, " ") + " KAS/" + kiroAgentServiceVersion + " acp-client/kiro-ide"
}

// applyKiroResponsesHeaders sets the headers the IDE sends with CreateResponse. The profile goes
// in x-amzn-kiro-profile here, not x-amzn-kiro-profile-arn.
func applyKiroResponsesHeaders(req *http.Request, account *config.Account, profileArn string, attempt int) {
	if token := accountBearerToken(account); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if config.IsExternalIdpAccount(account) {
		//! Kiro rejects an Entra token sent as a plain Bearer token without it, as on every other call.
		req.Header.Set("tokentype", "EXTERNAL_IDP")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", kiroResponsesUserAgent(account))
	req.Header.Set("x-amzn-kiro-origin", "AI_EDITOR")
	req.Header.Set("x-amzn-codewhisperer-optout", "true")
	req.Header.Set("x-amzn-kiro-attempt", fmt.Sprintf("%d;max=%d", attempt, kiroResponsesIDEAttempts))
	if profileArn != "" {
		req.Header.Set("x-amzn-kiro-profile", profileArn)
	}
}

// callKiroResponsesAPI sends the payload to CreateResponse and feeds its events to callback,
// the way callKiroLegacyAPI does for generateAssistantResponse. A stream that fails before
// any output is tried once more.
func callKiroResponsesAPI(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback) error {
	request := buildKiroResponsesRequest(payload)
	err := sendKiroResponses(ctx, account, payload.ProfileArn, request, callback)
	if !isReasoningRejection(err) || !replaysReasoning(request) {
		return err
	}
	//! Signed thinking from the client is replayed as reasoning items; a signature Kiro does
	//! not accept (from another backend, say) would fail every turn of the conversation.
	logger.Warnf("[KiroResponses] Kiro rejected the replayed reasoning (%v); retrying without it", err)
	traceEndpointFallback(ctx, account, kiroResponsesEndpointName, err)
	return sendKiroResponses(ctx, account, payload.ProfileArn, buildKiroResponsesRequest(withoutReplayedReasoning(payload)), callback)
}

// replaysReasoning reports whether the request replayed reasoning items.
func replaysReasoning(request *kiroResponsesRequest) bool {
	for _, item := range request.Input {
		if item["type"] == "reasoning" {
			return true
		}
	}
	return false
}

func sendKiroResponses(ctx context.Context, account *config.Account, profileArn string, request *kiroResponsesRequest, callback *KiroStreamCallback) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	logKiroResponsesBodyDebug(body)
	endpointURL := kiroResponsesURL(account, profileArn)

	//! As in callKiroLegacyAPI: a stream the output limiter cut stays open for drainCutStream.
	streamCtx, endStream := upstreamStreamContext(ctx)
	defer func() {
		if endStream != nil {
			endStream(nil)
		}
	}()

	var lastErr error
	for attempt := 1; attempt <= maxStreamAttemptsPerEndpoint; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(streamCtx, http.MethodPost, endpointURL, bytes.NewReader(body))
		if err != nil {
			return err
		}
		applyKiroResponsesHeaders(req, account, profileArn, attempt)

		resp, err := accountClient(account, true).Do(req)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			if isNoHealthyProxyError(err) {
				return noHealthyProxyFailure()
			}
			if text, ok := outboundProxyFailure(err); ok {
				logger.Warnf("[KiroResponses] %s: outbound proxy failed (%s): %v", accountEmailForLog(account), text, err)
				return err
			}
			logger.Warnf("[KiroResponses] Request failed: %s", proxypool.LogText(err))
			return err
		}

		if resp.StatusCode != http.StatusOK {
			errBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamErrorBytes))
			resp.Body.Close()
			noteKiroVersionGate(string(errBody))
			logger.Debugf("[KiroResponses] HTTP %d answer: %s", resp.StatusCode, errBody)
			failure := responsesHTTPFailure(resp.StatusCode, resp.Header, errBody, time.Now())
			var quota *upstreamQuotaError
			if errors.As(failure, &quota) {
				kind := "quota exhausted"
				if quota.throttled {
					kind = "throttled"
				}
				logger.Warnf("[KiroResponses] %s %s (%d, retry-after %s)", accountEmailForLog(account), kind, resp.StatusCode, textfmt.Duration(quota.retryFor))
			} else {
				logger.Warnf("[KiroResponses] %s rejected request: %v", accountEmailForLog(account), failure)
			}
			return failure
		}

		stream := newIdleTimeoutBody(resp.Body, kiroStreamIdleTimeout)
		events := responsesSSESource(stream)
		reader := newCutReader(ctx, events)
		emitted, err := consumeKiroEvents(reader.next, callback)
		noteAttemptOutput(ctx, emitted)
		if errors.Is(err, errStreamCut) {
			drainCutStream(ctx, account, reader, stream, endStream)
			endStream = nil
			return ctx.Err()
		}
		stream.Close()
		if err == nil {
			return nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		var quota *upstreamQuotaError
		//! Once a callback ran, the caller holds partial state; only the caller can decide to retry.
		if emitted || !isRetryableStreamError(err) || isUpstreamClientError(err) || errors.As(err, &quota) {
			return err
		}
		lastErr = err
		if attempt < maxStreamAttemptsPerEndpoint {
			logger.Warnf("[KiroResponses] Stream failed before any output (attempt %d/%d): %v", attempt, maxStreamAttemptsPerEndpoint, err)
			if err := streamRetryWait(ctx, streamRetryBackoff); err != nil {
				return err
			}
		}
	}
	return lastErr
}

// responsesInlineData matches the base64 of an inline image or file in a CreateResponse body.
var responsesInlineData = regexp.MustCompile(`;base64,[A-Za-z0-9+/=]{64,}"`)

// logKiroResponsesBodyDebug writes the CreateResponse body at debug level, inline data shortened.
func logKiroResponsesBodyDebug(body []byte) {
	if logger.GetLevel() > logger.LevelDebug {
		return
	}
	shortened := responsesInlineData.ReplaceAllFunc(body, func(match []byte) []byte {
		//! The match is ";base64," (8 bytes), the base64, then a closing quote.
		return []byte(fmt.Sprintf(`;base64,<%d base64 chars>"`, len(match)-9))
	})
	logger.Debugf("[KiroResponses] Request body: %s", shortened)
}
