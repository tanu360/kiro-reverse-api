package config

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"kiro-proxy/db"
)

func GenerateMachineId() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

type Account struct {
	ID       string `json:"id"`
	Email    string `json:"email,omitempty"`
	UserId   string `json:"userId,omitempty"`
	Nickname string `json:"nickname,omitempty"`

	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ClientID     string `json:"clientId,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
	AuthMethod   string `json:"authMethod"`
	Provider     string `json:"provider,omitempty"`
	Region       string `json:"region"`
	StartUrl     string `json:"startUrl,omitempty"`
	ExpiresAt    int64  `json:"expiresAt,omitempty"`
	MachineId    string `json:"machineId,omitempty"`
	ProfileArn   string `json:"profileArn,omitempty"`

	ProxyURL string `json:"proxyURL,omitempty"`

	Weight int `json:"weight,omitempty"`

	OverageStatus     string  `json:"overageStatus,omitempty"`
	OverageCapability string  `json:"overageCapability,omitempty"`
	OverageCap        float64 `json:"overageCap,omitempty"`
	OverageRate       float64 `json:"overageRate,omitempty"`
	CurrentOverages   float64 `json:"currentOverages,omitempty"`
	OverageCheckedAt  int64   `json:"overageCheckedAt,omitempty"`

	Enabled      bool   `json:"enabled"`
	Silent       bool   `json:"silent,omitempty"`
	SilentReason string `json:"silentReason,omitempty"`
	SilentTime   int64  `json:"silentTime,omitempty"`
	BanStatus    string `json:"banStatus,omitempty"`
	BanReason    string `json:"banReason,omitempty"`
	BanTime      int64  `json:"banTime,omitempty"`

	SubscriptionType  string `json:"subscriptionType,omitempty"`
	SubscriptionTitle string `json:"subscriptionTitle,omitempty"`
	DaysRemaining     int    `json:"daysRemaining,omitempty"`

	UsageCurrent  float64 `json:"usageCurrent,omitempty"`
	UsageLimit    float64 `json:"usageLimit,omitempty"`
	UsagePercent  float64 `json:"usagePercent,omitempty"`
	NextResetDate string  `json:"nextResetDate,omitempty"`
	LastRefresh   int64   `json:"lastRefresh,omitempty"`

	TrialUsageCurrent float64 `json:"trialUsageCurrent,omitempty"`
	TrialUsageLimit   float64 `json:"trialUsageLimit,omitempty"`
	TrialUsagePercent float64 `json:"trialUsagePercent,omitempty"`
	TrialStatus       string  `json:"trialStatus,omitempty"`
	TrialExpiresAt    int64   `json:"trialExpiresAt,omitempty"`

	RequestCount int     `json:"requestCount,omitempty"`
	ErrorCount   int     `json:"errorCount,omitempty"`
	LastUsed     int64   `json:"lastUsed,omitempty"`
	TotalTokens  int     `json:"totalTokens,omitempty"`
	TotalCredits float64 `json:"totalCredits,omitempty"`
}

type PromptFilterRule struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Match   string `json:"match"`
	Replace string `json:"replace,omitempty"`
	Enabled bool   `json:"enabled"`
}

type ApiKeyEntry struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	Key        string `json:"key"`
	Enabled    bool   `json:"enabled"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt int64  `json:"lastUsedAt,omitempty"`

	TokenLimit  int64   `json:"tokenLimit,omitempty"`
	CreditLimit float64 `json:"creditLimit,omitempty"`

	TokensUsed    int64   `json:"tokensUsed,omitempty"`
	CreditsUsed   float64 `json:"creditsUsed,omitempty"`
	RequestsCount int64   `json:"requestsCount,omitempty"`
}

type Config struct {
	Password      string        `json:"password"`
	Port          int           `json:"port"`
	Host          string        `json:"host"`
	RequireApiKey bool          `json:"requireApiKey"`
	ApiKeys       []ApiKeyEntry `json:"apiKeys,omitempty"`
	KiroVersion   string        `json:"kiroVersion,omitempty"`
	SystemVersion string        `json:"systemVersion,omitempty"`
	NodeVersion   string        `json:"nodeVersion,omitempty"`
	Accounts      []Account     `json:"accounts"`

	ThinkingSuffix       string `json:"thinkingSuffix,omitempty"`
	OpenAIThinkingFormat string `json:"openaiThinkingFormat,omitempty"`
	ClaudeThinkingFormat string `json:"claudeThinkingFormat,omitempty"`

	PreferredEndpoint string `json:"preferredEndpoint,omitempty"`

	EndpointFallback *bool `json:"endpointFallback,omitempty"`

	AllowOverUsage bool `json:"allowOverUsage,omitempty"`

	ProxyURL string `json:"proxyURL,omitempty"`

	FilterClaudeCode bool `json:"filterClaudeCode,omitempty"`

	FilterEnvNoise bool `json:"filterEnvNoise,omitempty"`

	FilterStripBoundaries bool `json:"filterStripBoundaries,omitempty"`

	PromptFilterRules []PromptFilterRule `json:"promptFilterRules,omitempty"`

	LogLevel string `json:"logLevel,omitempty"`

	MaxRetriesPerAccount int `json:"maxRetriesPerAccount,omitempty"`
	MaxRetriesPerRequest int `json:"maxRetriesPerRequest,omitempty"`
	RetryBaseDelayMs     int `json:"retryBaseDelayMs,omitempty"`
	RetryMaxDelayMs      int `json:"retryMaxDelayMs,omitempty"`

	TotalRequests   int     `json:"totalRequests,omitempty"`
	SuccessRequests int     `json:"successRequests,omitempty"`
	FailedRequests  int     `json:"failedRequests,omitempty"`
	TotalTokens     int     `json:"totalTokens,omitempty"`
	TotalCredits    float64 `json:"totalCredits,omitempty"`

	Backup BackupConfig `json:"backup,omitempty"`
}

type AccountInfo struct {
	Email             string
	UserId            string
	SubscriptionType  string
	SubscriptionTitle string
	DaysRemaining     int
	UsageCurrent      float64
	UsageLimit        float64
	UsagePercent      float64
	NextResetDate     string
	LastRefresh       int64
	TrialUsageCurrent float64
	TrialUsageLimit   float64
	TrialUsagePercent float64
	TrialStatus       string
	TrialExpiresAt    int64
}

const Version = "1.1.2"

var (
	cfg     *Config
	cfgLock sync.RWMutex
)

func Init(path string) error {
	dir := filepath.Dir(path)
	if err := db.Init(dir); err != nil {
		return fmt.Errorf("db init: %w", err)
	}
	if err := Load(); err != nil {
		return err
	}

	if err := LoadCredentials(); err != nil {
		return fmt.Errorf("load credentials: %w", err)
	}

	return nil
}

func Load() error {
	cfgLock.Lock()
	defer cfgLock.Unlock()

	raw, ok, err := getSetting("config")
	if err != nil {
		return err
	}
	if !ok {
		cfg = &Config{
			Password:      "changeme",
			Port:          8080,
			Host:          "0.0.0.0",
			RequireApiKey: false,
			Accounts:      []Account{},
		}
		return saveLocked()
	}

	var c Config
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return err
	}
	cfg = &c
	return nil
}

func Save() error {
	AutoSnapshotBeforeSave()
	return saveLocked()
}

// saveLocked writes the in-memory cfg to settings without acquiring cfgLock.
// Caller must already hold cfgLock for writing.
func saveLocked() error {
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return setSetting("config", string(data))
}

func SetPassword(password string) {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.Password = password
}

func Get() *Config {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return nil
	}
	copyCfg := *cfg
	if cfg.Accounts != nil {
		copyCfg.Accounts = append([]Account(nil), cfg.Accounts...)
	}
	if cfg.ApiKeys != nil {
		copyCfg.ApiKeys = append([]ApiKeyEntry(nil), cfg.ApiKeys...)
	}
	if cfg.PromptFilterRules != nil {
		copyCfg.PromptFilterRules = append([]PromptFilterRule(nil), cfg.PromptFilterRules...)
	}
	return &copyCfg
}

func GetPassword() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return cfg.Password
}

func GetPort() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg.Port == 0 {
		return 8080
	}
	return cfg.Port
}

func GetHost() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg.Host == "" {
		return "127.0.0.1"
	}
	return cfg.Host
}

func GetDataDir() string {
	return db.DataDir()
}

func GetAccounts() []Account {

	if CredentialsLoaded() {
		return GetCredentials()
	}

	cfgLock.RLock()
	defer cfgLock.RUnlock()
	accounts := make([]Account, len(cfg.Accounts))
	copy(accounts, cfg.Accounts)
	return accounts
}

func GetEnabledAccounts() []Account {

	all := GetAccounts()
	var accounts []Account
	for _, a := range all {
		if a.Enabled && !a.Silent && (a.BanStatus == "" || a.BanStatus == "ACTIVE") {
			accounts = append(accounts, a)
		}
	}
	return accounts
}

func AddAccount(account Account) error {

	if CredentialsLoaded() {
		return AddCredential(account)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.Accounts = append(cfg.Accounts, account)
	return Save()
}

func UpdateAccount(id string, account Account) error {

	if CredentialsLoaded() {
		return UpdateCredential(account)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i, a := range cfg.Accounts {
		if a.ID == id {
			cfg.Accounts[i] = account
			return Save()
		}
	}
	return nil
}

func UpdateAccountOverageStatus(id, status, capability string, cap, rate, current float64, checkedAt int64) error {

	if CredentialsLoaded() {
		return UpdateCredentialOverageStatus(id, status, capability, cap, rate, current, checkedAt)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i, a := range cfg.Accounts {
		if a.ID == id {
			if status != "" {
				cfg.Accounts[i].OverageStatus = status
			}
			if capability != "" {
				cfg.Accounts[i].OverageCapability = capability
			}
			cfg.Accounts[i].OverageCap = cap
			cfg.Accounts[i].OverageRate = rate
			cfg.Accounts[i].CurrentOverages = current
			if checkedAt > 0 {
				cfg.Accounts[i].OverageCheckedAt = checkedAt
			}
			return Save()
		}
	}
	return nil
}

func DisableAccountOverage(id string) error {
	return UpdateAccountOverageStatus(id, "DISABLED", "", 0, 0, 0, time.Now().Unix())
}

func SetAccountEnabled(id string, enabled bool) error {
	if CredentialsLoaded() {
		acc := GetCredentialByID(id)
		if acc == nil {
			return nil
		}
		acc.Enabled = enabled
		if !enabled {
			acc.BanStatus = "DISABLED"
			acc.BanTime = time.Now().Unix()
		}
		return UpdateCredential(*acc)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i := range cfg.Accounts {
		if cfg.Accounts[i].ID == id {
			cfg.Accounts[i].Enabled = enabled
			if !enabled {
				cfg.Accounts[i].BanStatus = "DISABLED"
				cfg.Accounts[i].BanTime = time.Now().Unix()
			}
			return Save()
		}
	}
	return nil
}

func SetAccountBanStatus(id, status, reason string) error {
	if CredentialsLoaded() {
		acc := GetCredentialByID(id)
		if acc == nil {
			return nil
		}
		acc.BanStatus = status
		acc.BanReason = reason
		acc.BanTime = time.Now().Unix()
		if status == "BANNED" || status == "DISABLED" {
			acc.Enabled = false
		}
		return UpdateCredential(*acc)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i := range cfg.Accounts {
		if cfg.Accounts[i].ID == id {
			cfg.Accounts[i].BanStatus = status
			cfg.Accounts[i].BanReason = reason
			cfg.Accounts[i].BanTime = time.Now().Unix()
			if status == "BANNED" || status == "DISABLED" {
				cfg.Accounts[i].Enabled = false
			}
			return Save()
		}
	}
	return nil
}

func UpdateAccountProfileArn(id, profileArn string) error {

	if CredentialsLoaded() {
		return UpdateCredentialProfileArn(id, profileArn)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i, a := range cfg.Accounts {
		if a.ID == id {
			cfg.Accounts[i].ProfileArn = profileArn
			return Save()
		}
	}
	return nil
}

func DeleteAccount(id string) error {

	if CredentialsLoaded() {
		return RemoveCredential(id)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i, a := range cfg.Accounts {
		if a.ID == id {
			cfg.Accounts = append(cfg.Accounts[:i], cfg.Accounts[i+1:]...)
			return Save()
		}
	}
	return nil
}

func UpdateAccountToken(id, accessToken, refreshToken string, expiresAt int64) error {

	if CredentialsLoaded() {
		return UpdateCredentialToken(id, accessToken, refreshToken, expiresAt)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i, a := range cfg.Accounts {
		if a.ID == id {
			cfg.Accounts[i].AccessToken = accessToken
			if refreshToken != "" {
				cfg.Accounts[i].RefreshToken = refreshToken
			}
			cfg.Accounts[i].ExpiresAt = expiresAt
			return Save()
		}
	}
	return nil
}

func IsApiKeyRequired() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return cfg.RequireApiKey
}

func UpdateSettingsPatch(requireApiKey *bool, password string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if requireApiKey != nil {
		cfg.RequireApiKey = *requireApiKey
	}
	if password != "" {
		cfg.Password = password
	}
	return Save()
}

func UpdateStats(totalReq, successReq, failedReq, totalTokens int, totalCredits float64) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.TotalRequests = totalReq
	cfg.SuccessRequests = successReq
	cfg.FailedRequests = failedReq
	cfg.TotalTokens = totalTokens
	cfg.TotalCredits = totalCredits
	return Save()
}

func GetStats() (int, int, int, int, float64) {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return cfg.TotalRequests, cfg.SuccessRequests, cfg.FailedRequests, cfg.TotalTokens, cfg.TotalCredits
}

func UpdateAccountStats(id string, requestCount, errorCount, totalTokens int, totalCredits float64, lastUsed int64) error {

	if CredentialsLoaded() {
		return UpdateCredentialStats(id, requestCount, errorCount, totalTokens, totalCredits, lastUsed)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i, a := range cfg.Accounts {
		if a.ID == id {
			cfg.Accounts[i].RequestCount = requestCount
			cfg.Accounts[i].ErrorCount = errorCount
			cfg.Accounts[i].TotalTokens = totalTokens
			cfg.Accounts[i].TotalCredits = totalCredits
			cfg.Accounts[i].LastUsed = lastUsed
			return Save()
		}
	}
	return nil
}

func UpdateAccountInfo(id string, info AccountInfo) error {

	if CredentialsLoaded() {

		acc := GetCredentialByID(id)
		if acc != nil {
			if info.Email != "" {
				acc.Email = info.Email
			}
			if info.UserId != "" {
				acc.UserId = info.UserId
			}
			if info.Email != "" || info.UserId != "" {
				if err := UpdateCredential(*acc); err != nil {
					return err
				}
			}
		}
		return UpdateCredentialInfo(id, info)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i, a := range cfg.Accounts {
		if a.ID == id {
			if info.Email != "" {
				cfg.Accounts[i].Email = info.Email
			}
			if info.UserId != "" {
				cfg.Accounts[i].UserId = info.UserId
			}
			cfg.Accounts[i].SubscriptionType = info.SubscriptionType
			cfg.Accounts[i].SubscriptionTitle = info.SubscriptionTitle
			cfg.Accounts[i].DaysRemaining = info.DaysRemaining
			cfg.Accounts[i].UsageCurrent = info.UsageCurrent
			cfg.Accounts[i].UsageLimit = info.UsageLimit
			cfg.Accounts[i].UsagePercent = info.UsagePercent
			cfg.Accounts[i].NextResetDate = info.NextResetDate
			cfg.Accounts[i].LastRefresh = info.LastRefresh
			cfg.Accounts[i].TrialUsageCurrent = info.TrialUsageCurrent
			cfg.Accounts[i].TrialUsageLimit = info.TrialUsageLimit
			cfg.Accounts[i].TrialUsagePercent = info.TrialUsagePercent
			cfg.Accounts[i].TrialStatus = info.TrialStatus
			cfg.Accounts[i].TrialExpiresAt = info.TrialExpiresAt
			return Save()
		}
	}
	return nil
}

func GetFilterClaudeCode() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return false
	}
	return cfg.FilterClaudeCode
}

func GetFilterEnvNoise() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return false
	}
	return cfg.FilterEnvNoise
}

func GetFilterStripBoundaries() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return false
	}
	return cfg.FilterStripBoundaries
}

type PromptFilterConfig struct {
	FilterClaudeCode      bool               `json:"filterClaudeCode"`
	FilterEnvNoise        bool               `json:"filterEnvNoise"`
	FilterStripBoundaries bool               `json:"filterStripBoundaries"`
	Rules                 []PromptFilterRule `json:"rules"`
}

func GetPromptFilterConfig() PromptFilterConfig {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return PromptFilterConfig{Rules: []PromptFilterRule{}}
	}
	rules := make([]PromptFilterRule, len(cfg.PromptFilterRules))
	copy(rules, cfg.PromptFilterRules)
	return PromptFilterConfig{
		FilterClaudeCode:      cfg.FilterClaudeCode,
		FilterEnvNoise:        cfg.FilterEnvNoise,
		FilterStripBoundaries: cfg.FilterStripBoundaries,
		Rules:                 rules,
	}
}

func UpdatePromptFilterConfig(filterClaudeCode, filterEnvNoise, filterStripBoundaries bool, rules []PromptFilterRule) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.FilterClaudeCode = filterClaudeCode
	cfg.FilterEnvNoise = filterEnvNoise
	cfg.FilterStripBoundaries = filterStripBoundaries
	if rules != nil {
		cfg.PromptFilterRules = rules
	}
	return Save()
}

func GetPromptFilterRules() []PromptFilterRule {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return nil
	}
	rules := make([]PromptFilterRule, len(cfg.PromptFilterRules))
	copy(rules, cfg.PromptFilterRules)
	return rules
}

type ThinkingConfig struct {
	Suffix       string `json:"suffix"`
	OpenAIFormat string `json:"openaiFormat"`
	ClaudeFormat string `json:"claudeFormat"`
}

func GetThinkingConfig() ThinkingConfig {
	cfgLock.RLock()
	defer cfgLock.RUnlock()

	suffix := cfg.ThinkingSuffix
	if suffix == "" {
		suffix = "-thinking"
	}
	openaiFormat := cfg.OpenAIThinkingFormat
	if openaiFormat == "" {
		openaiFormat = "reasoning_content"
	}
	claudeFormat := cfg.ClaudeThinkingFormat
	if claudeFormat == "" {
		claudeFormat = "thinking"
	}

	return ThinkingConfig{
		Suffix:       suffix,
		OpenAIFormat: openaiFormat,
		ClaudeFormat: claudeFormat,
	}
}

func UpdateThinkingConfig(suffix, openaiFormat, claudeFormat string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.ThinkingSuffix = suffix
	cfg.OpenAIThinkingFormat = openaiFormat
	cfg.ClaudeThinkingFormat = claudeFormat
	return Save()
}

func GetPreferredEndpoint() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg.PreferredEndpoint == "" {
		return "auto"
	}
	return cfg.PreferredEndpoint
}

func UpdatePreferredEndpoint(endpoint string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.PreferredEndpoint = endpoint
	return Save()
}

func GetEndpointFallback() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg.EndpointFallback == nil {
		return true
	}
	return *cfg.EndpointFallback
}

func UpdateEndpointFallback(enabled bool) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.EndpointFallback = &enabled
	return Save()
}

func GetProxyURL() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return cfg.ProxyURL
}

func UpdateProxySettings(proxyURL string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.ProxyURL = proxyURL
	return Save()
}

func GetAllowOverUsage() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return false
	}
	return cfg.AllowOverUsage
}

func UpdateAllowOverUsage(allow bool) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.AllowOverUsage = allow
	return Save()
}

func GetLogLevel() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return "info"
	}
	if cfg.LogLevel == "" {
		return "info"
	}
	return cfg.LogLevel
}

func GetRetryConfig() (maxPerAccount, maxPerRequest, baseDelayMs, maxDelayMs int) {
	cfgLock.RLock()
	defer cfgLock.RUnlock()

	maxPerAccount = 3
	maxPerRequest = 9
	baseDelayMs = 100
	maxDelayMs = 5000

	if cfg != nil {
		if cfg.MaxRetriesPerAccount > 0 {
			maxPerAccount = cfg.MaxRetriesPerAccount
		}
		if cfg.MaxRetriesPerRequest > 0 {
			maxPerRequest = cfg.MaxRetriesPerRequest
		}
		if cfg.RetryBaseDelayMs > 0 {
			baseDelayMs = cfg.RetryBaseDelayMs
		}
		if cfg.RetryMaxDelayMs > 0 {
			maxDelayMs = cfg.RetryMaxDelayMs
		}
	}

	return
}

func UpdateLogLevel(level string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.LogLevel = level
	return Save()
}

type KiroClientConfig struct {
	KiroVersion   string
	SystemVersion string
	NodeVersion   string
}

func GetKiroClientConfig() KiroClientConfig {
	cfgLock.RLock()
	defer cfgLock.RUnlock()

	kiroVersion := "0.11.107"
	if cfg != nil && cfg.KiroVersion != "" {
		kiroVersion = cfg.KiroVersion
	}

	systemVersion := ""
	if cfg != nil {
		systemVersion = cfg.SystemVersion
	}
	if systemVersion == "" {
		systemVersion = defaultSystemVersion()
	}

	nodeVersion := "22.22.0"
	if cfg != nil && cfg.NodeVersion != "" {
		nodeVersion = cfg.NodeVersion
	}

	return KiroClientConfig{
		KiroVersion:   kiroVersion,
		SystemVersion: systemVersion,
		NodeVersion:   nodeVersion,
	}
}

func defaultSystemVersion() string {
	switch runtime.GOOS {
	case "windows":
		return "win32#10.0.22631"
	case "darwin":
		return "darwin#24.6.0"
	default:
		return "linux#6.6.87"
	}
}
