package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"kiro-proxy/config"
	"net/http"
	"time"
)

var oidcTokenURL = func(region string) string {
	return fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
}

var socialTokenURL = func() string {
	return "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
}

func RefreshToken(account *config.Account) (string, string, int64, string, error) {
	return RefreshTokenContext(context.Background(), account)
}

func RefreshTokenContext(ctx context.Context, account *config.Account) (string, string, int64, string, error) {
	if config.IsAPIKeyAccount(account) {
		return "", "", 0, "", fmt.Errorf("kiro API key accounts do not support token refresh")
	}

	//! Account proxy wins over global proxy so mixed-account pools can route independently.
	proxyURL := account.ProxyURL
	if proxyURL == "" {
		proxyURL = config.GetProxyURL()
	}
	client := GetAuthClientForProxy(proxyURL)

	if config.IsExternalIdpAccount(account) {
		return refreshExternalIdpToken(ctx, account.RefreshToken, account.ClientID, account.TokenEndpoint, account.IssuerURL, account.Scopes, client)
	}
	if account.AuthMethod == "social" {
		return refreshSocialToken(ctx, account.RefreshToken, client)
	}
	return refreshOIDCToken(ctx, account.RefreshToken, account.ClientID, account.ClientSecret, account.Region, client)
}

func refreshOIDCToken(ctx context.Context, refreshToken, clientID, clientSecret, region string, client *http.Client) (string, string, int64, string, error) {
	if clientID == "" || clientSecret == "" {
		return "", "", 0, "", fmt.Errorf("OIDC refresh requires clientId and clientSecret")
	}
	if region == "" {
		region = "us-east-1"
	}

	url := oidcTokenURL(region)

	payload := map[string]string{
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"refreshToken": refreshToken,
		"grantType":    "refresh_token",
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return "", "", 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", 0, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", "", 0, "", fmt.Errorf("refresh failed: %d %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
		ProfileArn   string `json:"profileArn"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", 0, "", err
	}

	expiresAt := time.Now().Unix() + int64(result.ExpiresIn)
	return result.AccessToken, result.RefreshToken, expiresAt, result.ProfileArn, nil
}

func refreshSocialToken(ctx context.Context, refreshToken string, client *http.Client) (string, string, int64, string, error) {
	url := socialTokenURL()

	payload := map[string]string{
		"refreshToken": refreshToken,
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return "", "", 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", 0, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", "", 0, "", fmt.Errorf("refresh failed: %d %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
		ProfileArn   string `json:"profileArn"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", 0, "", err
	}

	expiresAt := time.Now().Unix() + int64(result.ExpiresIn)
	return result.AccessToken, result.RefreshToken, expiresAt, result.ProfileArn, nil
}
