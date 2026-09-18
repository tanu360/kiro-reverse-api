package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"net/http"
	neturl "net/url"
	"strings"
	"sync"
	"time"
)

const (
	kiroRestAPIBase               = "https://codewhisperer.us-east-1.amazonaws.com"
	profileArnUnsupportedCooldown = 24 * time.Hour
	maxProfilePages               = 20
	maxProfileResponseBytes       = 1 << 20
	maxProfileErrorBytes          = 64 << 10
)

var (
	profileArnResolutionCooldowns sync.Map

	errProfileArnLookupSuppressed  = errors.New("profile ARN resolution skipped: previous Builder ID profile lookup was unsupported")
	errProfileArnLookupUnsupported = errors.New("profile ARN unsupported for Builder ID account")
)

func GetUsageLimits(account *config.Account) (*UsageLimitsResponse, error) {
	ensureRestProfileArn(account)
	url := fmt.Sprintf("%s/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true", kiroRestAPIBase)
	url = regionalizeURL(url, account)
	url = withProfileArnQuery(url, account)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	setKiroHeaders(req, account)

	resp, err := GetRestClientForProxy(ResolveAccountProxyURL(account)).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result UsageLimitsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func GetUserInfo(account *config.Account) (*UserInfoResponse, error) {
	url := regionalizeURL(fmt.Sprintf("%s/GetUserInfo", kiroRestAPIBase), account)

	payload := `{"origin":"KIRO_IDE"}`
	req, err := http.NewRequest("POST", url, strings.NewReader(payload))
	if err != nil {
		return nil, err
	}

	setKiroHeaders(req, account)
	req.Header.Set("Content-Type", "application/json")

	resp, err := GetRestClientForProxy(ResolveAccountProxyURL(account)).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result UserInfoResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func ListAvailableModels(account *config.Account) ([]ModelInfo, error) {
	ensureRestProfileArn(account)
	url := fmt.Sprintf("%s/ListAvailableModels?origin=AI_EDITOR&maxResults=50", kiroRestAPIBase)
	url = regionalizeURL(url, account)
	url = withProfileArnQuery(url, account)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	setKiroHeaders(req, account)

	resp, err := GetRestClientForProxy(ResolveAccountProxyURL(account)).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Models []ModelInfo `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result.Models, nil
}

func ResolveProfileArn(account *config.Account) (string, error) {
	return resolveProfileArnContext(context.Background(), account)
}

func resolveProfileArnContext(ctx context.Context, account *config.Account) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if account == nil {
		return "", fmt.Errorf("account is nil")
	}
	//! API keys have no IDE profile; a lookup would only fail and spam the log.
	if config.IsAPIKeyAccount(account) {
		return "", nil
	}
	if profileArn := strings.TrimSpace(account.ProfileArn); profileArn != "" {
		return profileArn, nil
	}

	suppressed := isProfileArnResolutionSuppressed(account)
	var lookupErr error
	if !suppressed {
		profileArn, err := resolveProfileArnAcrossRegions(ctx, account)
		if err == nil {
			cacheResolvedProfileArn(account, profileArn)
			return profileArn, nil
		}
		lookupErr = err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	//! AWS refresh responses can carry profileArn, so refresh stays the fallback even for Builder ID.
	if account.RefreshToken != "" {
		var refreshedArn string
		var refreshErr error
		if storedAccount(account.ID) != nil {
			refreshErr = refreshStoredAccount(ctx, account, true)
			refreshedArn = account.ProfileArn
		} else {
			// Credential import probes an account before it is persisted.
			var accessToken, refreshToken string
			var expiresAt int64
			accessToken, refreshToken, expiresAt, refreshedArn, refreshErr = auth.RefreshTokenContext(ctx, account)
			if refreshErr == nil {
				account.AccessToken = accessToken
				if refreshToken != "" {
					account.RefreshToken = refreshToken
				}
				account.ExpiresAt = expiresAt
			}
		}
		if refreshErr == nil && refreshedArn != "" {
			cacheResolvedProfileArn(account, refreshedArn)
			return refreshedArn, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if suppressed {
		return "", errProfileArnLookupSuppressed
	}
	if isBuilderIDProfileUnsupportedError(account, lookupErr) {
		suppressProfileArnResolution(account)
		logger.Debugf("[ProfileArn] Builder ID profile lookup unsupported for %s: %v", accountEmailForLog(account), lookupErr)
		return "", errProfileArnLookupUnsupported
	}
	return "", fmt.Errorf("no available Kiro profile: %w", lookupErr)
}

func cacheResolvedProfileArn(account *config.Account, profileArn string) {
	if err := config.UpdateAccountProfileArn(account.ID, profileArn); err != nil {
		logger.Warnf("[ProfileArn] Failed to cache profile ARN for %s: %v", account.Email, err)
	}
	account.ProfileArn = profileArn
}

func ensureRestProfileArn(account *config.Account) {
	//! REST calls worked without an ARN before, so a failed lookup degrades to that instead of failing the call.
	if account == nil || strings.TrimSpace(account.ProfileArn) != "" || config.IsAPIKeyAccount(account) {
		return
	}
	if _, err := ResolveProfileArn(account); err != nil {
		if isProfileArnResolutionSoftError(err) {
			logger.Debugf("[ProfileArn] Continuing REST request without profile ARN for %s: %v", accountEmailForLog(account), err)
			return
		}
		logger.Warnf("[ProfileArn] Continuing REST request without profile ARN for %s: %v", accountEmailForLog(account), err)
	}
}

func isBuilderIDProfileUnsupportedError(account *config.Account, err error) bool {
	if account == nil || err == nil || !strings.EqualFold(strings.TrimSpace(account.Provider), "BuilderId") {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "HTTP 403") && strings.Contains(msg, "AWS Builder ID is not supported for this operation")
}

func isProfileArnResolutionSoftError(err error) bool {
	return errors.Is(err, errProfileArnLookupSuppressed) || errors.Is(err, errProfileArnLookupUnsupported)
}

func profileArnCooldownKey(account *config.Account) string {
	if account == nil {
		return ""
	}
	provider := strings.TrimSpace(account.Provider)
	for _, id := range []string{account.ID, account.UserId, account.Email} {
		if id = strings.TrimSpace(id); id != "" {
			return provider + "\x00" + id
		}
	}
	return ""
}

func suppressProfileArnResolution(account *config.Account) {
	//! Builder ID cannot list profiles; without a cooldown every request would re-probe and log the same 403.
	if key := profileArnCooldownKey(account); key != "" {
		profileArnResolutionCooldowns.Store(key, time.Now().Add(profileArnUnsupportedCooldown))
	}
}

func isProfileArnResolutionSuppressed(account *config.Account) bool {
	key := profileArnCooldownKey(account)
	if key == "" {
		return false
	}
	value, ok := profileArnResolutionCooldowns.Load(key)
	if !ok {
		return false
	}
	if until, ok := value.(time.Time); !ok || time.Now().After(until) {
		profileArnResolutionCooldowns.Delete(key)
		return false
	}
	return true
}

func resolveProfileArnAcrossRegions(ctx context.Context, account *config.Account) (string, error) {
	var probeErrors []error
	for _, region := range kiroProfileRegionCandidates(account) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		profileArn, err := listAvailableProfilesWithRetry(ctx, account, region)
		if err == nil {
			return profileArn, nil
		}
		if isBuilderIDProfileUnsupportedError(account, err) {
			return "", err
		}
		probeErrors = append(probeErrors, fmt.Errorf("%s: %w", region, err))
	}
	return "", errors.Join(probeErrors...)
}

func listAvailableProfilesWithRetry(ctx context.Context, account *config.Account, region string) (string, error) {
	const maxAttempts = 3
	backoff := 200 * time.Millisecond

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		profileArn, err := listAvailableProfiles(ctx, account, region)
		if err == nil {
			return profileArn, nil
		}
		lastErr = err
		if !isTransientProfileFetchError(err) || attempt == maxAttempts {
			return "", err
		}
		logger.Debugf("[ProfileArn] ListAvailableProfiles transient failure for %s in %s (attempt %d/%d): %v",
			account.Email, region, attempt, maxAttempts, err)
		if err := waitForStreamRetry(ctx, backoff); err != nil {
			return "", err
		}
		backoff *= 2
	}
	return "", lastErr
}

func isTransientProfileFetchError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if strings.Contains(msg, "empty profile list") || strings.Contains(msg, "no valid Kiro profile ARN") {
		return false
	}
	if strings.HasPrefix(msg, "HTTP ") {
		return strings.HasPrefix(msg, "HTTP 5") || strings.HasPrefix(msg, "HTTP 429")
	}
	return true
}

func listAvailableProfiles(ctx context.Context, account *config.Account, region string) (string, error) {
	endpoint := regionalizeURLForRegion(fmt.Sprintf("%s/ListAvailableProfiles", kiroRestAPIBase), region)
	client := GetRestClientForProxy(ResolveAccountProxyURL(account))

	invalidCount := 0
	nextToken := ""
	//! Pages are bounded so a misbehaving upstream cannot loop forever.
	for page := 0; page < maxProfilePages; page++ {
		requestBody := map[string]interface{}{"maxResults": 50}
		if nextToken != "" {
			requestBody["nextToken"] = nextToken
		}
		payload, _ := json.Marshal(requestBody)
		req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(string(payload)))
		if err != nil {
			return "", err
		}
		setKiroHeaders(req, account)
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, maxProfileErrorBytes))
			resp.Body.Close()
			return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxProfileResponseBytes+1))
		resp.Body.Close()
		if err != nil {
			return "", err
		}
		if len(body) > maxProfileResponseBytes {
			return "", fmt.Errorf("profile response exceeds %d bytes", maxProfileResponseBytes)
		}

		var result struct {
			Profiles []struct {
				Arn string `json:"arn"`
			} `json:"profiles"`
			NextToken string `json:"nextToken"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			return "", err
		}
		for _, profile := range result.Profiles {
			if profileArn, _, ok := parseKiroProfileArn(profile.Arn); ok {
				return profileArn, nil
			}
			invalidCount++
		}
		if nextToken = strings.TrimSpace(result.NextToken); nextToken == "" {
			break
		}
	}
	if invalidCount > 0 {
		return "", fmt.Errorf("profile response contained no valid Kiro profile ARN")
	}
	return "", fmt.Errorf("empty profile list")
}

func withProfileArnQuery(rawURL string, account *config.Account) string {
	if account == nil {
		return rawURL
	}
	profileArn := strings.TrimSpace(account.ProfileArn)
	if profileArn == "" {
		return rawURL
	}
	return rawURL + "&profileArn=" + neturl.QueryEscape(profileArn)
}

func setKiroHeaders(req *http.Request, account *config.Account) {
	host := ""
	if req.URL != nil {
		host = req.URL.Host
	}
	headerValues := buildRuntimeHeaderValues(account, host)

	req.Header.Set("Accept", "application/json")
	applyKiroBaseHeaders(req, account, headerValues)
}

func RefreshAccountInfo(account *config.Account) (*config.AccountInfo, error) {
	info := &config.AccountInfo{
		LastRefresh: time.Now().Unix(),
	}

	usage, err := GetUsageLimits(account)
	if err != nil {

		errMsg := err.Error()
		if strings.Contains(errMsg, "TEMPORARILY_SUSPENDED") {

			logger.Warnf("[RefreshAccountInfo] Account %s is temporarily suspended: %v", account.Email, err)

			updatedAccount := *account
			updatedAccount.Enabled = false
			updatedAccount.BanStatus = "BANNED"
			updatedAccount.BanReason = "AWS temporarily suspended - unusual user activity detected"
			updatedAccount.BanTime = time.Now().Unix()

			if updateErr := config.UpdateAccount(account.ID, updatedAccount); updateErr != nil {
				logger.Errorf("[RefreshAccountInfo] Failed to update account ban status: %v", updateErr)
			}

			return nil, fmt.Errorf("account suspended: %w", err)
		} else if strings.Contains(errMsg, "403") || strings.Contains(errMsg, "401") ||
			strings.Contains(errMsg, "invalid") || strings.Contains(errMsg, "expired") {

			logger.Warnf("[RefreshAccountInfo] Authentication error for %s: %v", account.Email, err)

			updatedAccount := *account
			updatedAccount.Enabled = false
			updatedAccount.BanStatus = "BANNED"
			updatedAccount.BanReason = "Authentication failed - token invalid or expired"
			updatedAccount.BanTime = time.Now().Unix()

			if updateErr := config.UpdateAccount(account.ID, updatedAccount); updateErr != nil {
				logger.Errorf("[RefreshAccountInfo] Failed to update account ban status: %v", updateErr)
			}
		}

		return nil, fmt.Errorf("GetUsageLimits: %w", err)
	}

	if account.BanStatus != "" && account.BanStatus != "ACTIVE" {
		logger.Infof("[RefreshAccountInfo] Account %s is now active, clearing ban status", account.Email)

		updatedAccount := *account
		updatedAccount.BanStatus = "ACTIVE"
		updatedAccount.BanReason = ""
		updatedAccount.BanTime = 0

		if updateErr := config.UpdateAccount(account.ID, updatedAccount); updateErr != nil {
			logger.Errorf("[RefreshAccountInfo] Failed to clear account ban status: %v", updateErr)
		}
	}

	if usage.UserInfo != nil {
		info.Email = usage.UserInfo.Email
		info.UserId = usage.UserInfo.UserId
	}

	if usage.SubscriptionInfo != nil {

		titleOrName := usage.SubscriptionInfo.SubscriptionTitle
		if titleOrName == "" {
			titleOrName = usage.SubscriptionInfo.SubscriptionName
		}
		if titleOrName == "" {
			titleOrName = usage.SubscriptionInfo.SubscriptionType
		}
		info.SubscriptionType = parseSubscriptionType(titleOrName)
		info.SubscriptionTitle = usage.SubscriptionInfo.SubscriptionTitle
		if info.SubscriptionTitle == "" {
			info.SubscriptionTitle = usage.SubscriptionInfo.SubscriptionName
		}
		logger.Debugf("[RefreshAccountInfo] Subscription: type=%s, title=%s, name=%s, parsed=%s",
			usage.SubscriptionInfo.SubscriptionType,
			usage.SubscriptionInfo.SubscriptionTitle,
			usage.SubscriptionInfo.SubscriptionName,
			info.SubscriptionType)
	}

	if breakdown := creditUsageBreakdown(usage.UsageBreakdownList); breakdown != nil {
		info.UsageCurrent = breakdown.CurrentUsageValue()
		info.UsageLimit = breakdown.UsageLimitValue()
		if info.UsageLimit > 0 {
			info.UsagePercent = info.UsageCurrent / info.UsageLimit
		}
	}

	if usage.NextDateReset != "" {
		if ts, err := usage.NextDateReset.Int64(); err == nil && ts > 0 {
			info.NextResetDate = time.Unix(ts, 0).Format("2006-01-02")
		} else if f, err := usage.NextDateReset.Float64(); err == nil && f > 0 {
			info.NextResetDate = time.Unix(int64(f), 0).Format("2006-01-02")
		}
	}

	if breakdown := creditUsageBreakdown(usage.UsageBreakdownList); breakdown != nil {
		if breakdown.FreeTrialInfo != nil {
			info.TrialUsageCurrent = breakdown.FreeTrialInfo.CurrentUsageValue()
			info.TrialUsageLimit = breakdown.FreeTrialInfo.UsageLimitValue()
			if info.TrialUsageLimit > 0 {
				info.TrialUsagePercent = info.TrialUsageCurrent / info.TrialUsageLimit
			}
			info.TrialStatus = breakdown.FreeTrialInfo.FreeTrialStatus

			if breakdown.FreeTrialInfo.FreeTrialExpiry != "" {
				if ts, err := breakdown.FreeTrialInfo.FreeTrialExpiry.Int64(); err == nil && ts > 0 {
					info.TrialExpiresAt = ts
				} else if f, err := breakdown.FreeTrialInfo.FreeTrialExpiry.Float64(); err == nil && f > 0 {
					info.TrialExpiresAt = int64(f)
				}
			}
		}
	}

	return info, nil
}

func creditUsageBreakdown(breakdowns []UsageBreakdown) *UsageBreakdown {
	for i := range breakdowns {
		if strings.EqualFold(breakdowns[i].ResourceType, "CREDIT") {
			return &breakdowns[i]
		}
	}
	if len(breakdowns) == 0 {
		return nil
	}
	return &breakdowns[0]
}

func parseSubscriptionType(raw string) string {
	upper := strings.ToUpper(raw)
	if strings.Contains(upper, "PRO_PLUS") || strings.Contains(upper, "PROPLUS") {
		return "PRO_PLUS"
	}
	if strings.Contains(upper, "POWER") {
		return "POWER"
	}
	if strings.Contains(upper, "PRO") {
		return "PRO"
	}
	return "FREE"
}

type UsageLimitsResponse struct {
	UsageBreakdownList []UsageBreakdown  `json:"usageBreakdownList"`
	NextDateReset      json.Number       `json:"nextDateReset"`
	SubscriptionInfo   *SubscriptionInfo `json:"subscriptionInfo"`
	UserInfo           *UserInfo         `json:"userInfo"`
}

type UsageBreakdown struct {
	ResourceType              string         `json:"resourceType"`
	CurrentUsage              float64        `json:"currentUsage"`
	CurrentUsageWithPrecision *float64       `json:"currentUsageWithPrecision,omitempty"`
	UsageLimit                float64        `json:"usageLimit"`
	UsageLimitWithPrecision   *float64       `json:"usageLimitWithPrecision,omitempty"`
	Currency                  string         `json:"currency"`
	Unit                      string         `json:"unit"`
	OverageRate               float64        `json:"overageRate"`
	FreeTrialInfo             *FreeTrialInfo `json:"freeTrialInfo"`
	Bonuses                   []BonusInfo    `json:"bonuses"`
}

func (b UsageBreakdown) CurrentUsageValue() float64 {
	if b.CurrentUsageWithPrecision != nil {
		return *b.CurrentUsageWithPrecision
	}
	return b.CurrentUsage
}

func (b UsageBreakdown) UsageLimitValue() float64 {
	if b.UsageLimitWithPrecision != nil {
		return *b.UsageLimitWithPrecision
	}
	return b.UsageLimit
}

type FreeTrialInfo struct {
	CurrentUsage              float64     `json:"currentUsage"`
	CurrentUsageWithPrecision *float64    `json:"currentUsageWithPrecision,omitempty"`
	UsageLimit                float64     `json:"usageLimit"`
	UsageLimitWithPrecision   *float64    `json:"usageLimitWithPrecision,omitempty"`
	FreeTrialStatus           string      `json:"freeTrialStatus"`
	FreeTrialExpiry           json.Number `json:"freeTrialExpiry"`
}

func (f FreeTrialInfo) CurrentUsageValue() float64 {
	if f.CurrentUsageWithPrecision != nil {
		return *f.CurrentUsageWithPrecision
	}
	return f.CurrentUsage
}

func (f FreeTrialInfo) UsageLimitValue() float64 {
	if f.UsageLimitWithPrecision != nil {
		return *f.UsageLimitWithPrecision
	}
	return f.UsageLimit
}

type BonusInfo struct {
	BonusCode    string      `json:"bonusCode"`
	DisplayName  string      `json:"displayName"`
	CurrentUsage float64     `json:"currentUsage"`
	UsageLimit   float64     `json:"usageLimit"`
	ExpiresAt    json.Number `json:"expiresAt"`
	Status       string      `json:"status"`
}

type SubscriptionInfo struct {
	SubscriptionName  string `json:"subscriptionName"`
	SubscriptionTitle string `json:"subscriptionTitle"`
	SubscriptionType  string `json:"subscriptionType"`
	Status            string `json:"status"`
	UpgradeCapability string `json:"upgradeCapability"`
}

type UserInfo struct {
	Email  string `json:"email"`
	UserId string `json:"userId"`
}

type UserInfoResponse struct {
	Email  string `json:"email"`
	UserId string `json:"userId"`
	Idp    string `json:"idp"`
	Status string `json:"status"`
}

type ModelInfo struct {
	ModelId                            string                 `json:"modelId"`
	ModelName                          string                 `json:"modelName"`
	Description                        string                 `json:"description"`
	InputTypes                         []string               `json:"supportedInputTypes"`
	RateMultiplier                     float64                `json:"rateMultiplier"`
	AdditionalModelRequestFieldsSchema map[string]interface{} `json:"additionalModelRequestFieldsSchema,omitempty"`
	TokenLimits                        *struct {
		MaxInputTokens  int `json:"maxInputTokens"`
		MaxOutputTokens int `json:"maxOutputTokens"`
	} `json:"tokenLimits"`
}
