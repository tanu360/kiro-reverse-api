package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

const kiroQAPIBase = "https://q.us-east-1.amazonaws.com"

type OverageSnapshot struct {
	Status            string  `json:"status"`
	Capability        string  `json:"capability"`
	SubscriptionTitle string  `json:"subscriptionTitle"`
	OverageCap        float64 `json:"overageCap"`
	OverageRate       float64 `json:"overageRate"`
	CurrentOverages   float64 `json:"currentOverages"`
	CheckedAt         int64   `json:"checkedAt"`
}

type upstreamOverageResponse struct {
	OverageConfiguration *struct {
		OverageStatus string `json:"overageStatus"`
	} `json:"overageConfiguration"`
	SubscriptionInfo *struct {
		OverageCapability string `json:"overageCapability"`
		SubscriptionTitle string `json:"subscriptionTitle"`
	} `json:"subscriptionInfo"`
	UsageBreakdownList []struct {
		ResourceType    string  `json:"resourceType"`
		OverageCap      float64 `json:"overageCap"`
		OverageRate     float64 `json:"overageRate"`
		CurrentOverages float64 `json:"currentOverages"`
	} `json:"usageBreakdownList"`
}

func FetchOverageStatus(account *config.Account) (*OverageSnapshot, error) {
	if account == nil {
		return nil, fmt.Errorf("account is nil")
	}

	rawURL := kiroQAPIBase + "/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true"
	if profileArn := strings.TrimSpace(account.ProfileArn); profileArn != "" {
		rawURL += "&profileArn=" + neturl.QueryEscape(profileArn)
	}

	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	setKiroHeaders(req, account)

	resp, err := GetRestClientForProxy(ResolveAccountProxyURL(account)).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var parsed upstreamOverageResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode getUsageLimits: %w", err)
	}

	snap := &OverageSnapshot{
		Status:    "UNKNOWN",
		CheckedAt: time.Now().Unix(),
	}
	if parsed.OverageConfiguration != nil && parsed.OverageConfiguration.OverageStatus != "" {
		snap.Status = strings.ToUpper(parsed.OverageConfiguration.OverageStatus)
	}
	if parsed.SubscriptionInfo != nil {
		snap.Capability = parsed.SubscriptionInfo.OverageCapability
		snap.SubscriptionTitle = parsed.SubscriptionInfo.SubscriptionTitle
	}
	for _, breakdown := range parsed.UsageBreakdownList {
		if breakdown.OverageCap > 0 || breakdown.OverageRate > 0 || breakdown.CurrentOverages > 0 {
			snap.OverageCap = breakdown.OverageCap
			snap.OverageRate = breakdown.OverageRate
			snap.CurrentOverages = breakdown.CurrentOverages
			break
		}
	}
	return snap, nil
}

func SetOverageStatus(account *config.Account, enabled bool) (*OverageSnapshot, error) {
	if account == nil {
		return nil, fmt.Errorf("account is nil")
	}

	profileArn, err := ResolveProfileArn(account)
	if err != nil {
		return nil, fmt.Errorf("resolve profileArn: %w", err)
	}

	status := "DISABLED"
	if enabled {
		status = "ENABLED"
	}
	payload := map[string]interface{}{
		"overageConfiguration": map[string]string{
			"overageStatus": status,
		},
		"profileArn": profileArn,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", kiroQAPIBase+"/setUserPreference", bytes.NewReader(body))
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

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("setUserPreference HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	logger.Infof("[Overage] account=%s flipped overageStatus=%s upstream", account.Email, status)

	snap, fetchErr := FetchOverageStatus(account)
	if fetchErr != nil {
		logger.Warnf("[Overage] re-fetch after switch failed for %s: %v", account.Email, fetchErr)
		return &OverageSnapshot{
			Status:    status,
			CheckedAt: time.Now().Unix(),
		}, nil
	}
	snap.Status = status
	return snap, nil
}

func PersistOverageSnapshot(accountID string, snap *OverageSnapshot) error {
	if snap == nil {
		return nil
	}
	return config.UpdateAccountOverageStatus(
		accountID,
		snap.Status,
		snap.Capability,
		snap.OverageCap,
		snap.OverageRate,
		snap.CurrentOverages,
		snap.CheckedAt,
	)
}
