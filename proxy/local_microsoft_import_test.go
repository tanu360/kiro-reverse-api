package proxy

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"kiro-proxy/auth"
	"kiro-proxy/config"
)

// The admin "Local Kiro files" import posts a Kiro IDE Microsoft token file
// whose v1 access token names the tenant only as https://sts.windows.net/<tid>/.
func TestLocalMicrosoftTokenFileWithV1AccessTokenImports(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)
	v1AccessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss": "https://sts.windows.net/" + handlerMicrosoftTenantID + "/",
		"tid": handlerMicrosoftTenantID,
		"aud": "api://" + handlerMicrosoftClientID,
		"exp": time.Now().Add(30 * time.Minute).Unix(),
	})
	refreshed := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                handlerMicrosoftIssuerURL(),
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "ide-user@example.com",
		"exp":                time.Now().Add(time.Hour).Unix(),
	})
	previous := auth.SetGlobalAuthClientForTest(&http.Client{Timeout: time.Second, Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != handlerMicrosoftTokenEndpoint() {
			return nil, fmt.Errorf("unexpected auth request: %s", request.URL)
		}
		return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
			"access_token": refreshed, "refresh_token": "rotated", "expires_in": 3600,
		}), nil
	})})
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previous) })

	recorder := callImportCredentialsHandler(t, h, map[string]interface{}{
		"refreshToken": "ide-refresh",
		"accessToken":  v1AccessToken,
		"clientId":     handlerMicrosoftClientID,
		"authMethod":   "external_idp",
		"provider":     "AzureAD",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("import status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	got := config.GetAccounts()
	if len(got) != 1 || got[0].TokenEndpoint != handlerMicrosoftTokenEndpoint() || got[0].IssuerURL != handlerMicrosoftIssuerURL() || got[0].RefreshToken != "rotated" {
		t.Fatalf("imported account = %+v", got)
	}
}
