package auth

import "testing"

func TestDeriveExternalIdpEndpointsAcceptsV1AccessTokenIssuer(t *testing.T) {
	v1Token := microsoftTestJWT(t, map[string]any{
		"iss": "https://sts.windows.net/" + testMicrosoftTenantID + "/",
		"tid": testMicrosoftTenantID,
	})
	endpoint, issuer, scopes := DeriveExternalIdpEndpoints("", testMicrosoftClientID, v1Token)
	if endpoint != "https://login.microsoftonline.com/"+testMicrosoftTenantID+"/oauth2/v2.0/token" ||
		issuer != "https://login.microsoftonline.com/"+testMicrosoftTenantID+"/v2.0" || scopes == "" {
		t.Fatalf("v1 issuer not mapped: endpoint=%q issuer=%q scopes=%q", endpoint, issuer, scopes)
	}

	for _, iss := range []string{
		"https://sts.windows.net/not-a-tenant/",
		"https://sts.windows.net.evil.example/" + testMicrosoftTenantID + "/",
		"http://sts.windows.net/" + testMicrosoftTenantID + "/",
		"https://sts.windows.net/" + testMicrosoftTenantID + "/extra/",
	} {
		token := microsoftTestJWT(t, map[string]any{"iss": iss})
		if endpoint, issuer, _ := DeriveExternalIdpEndpoints("", testMicrosoftClientID, token); endpoint != "" || issuer != "" {
			t.Fatalf("iss %q derived endpoint=%q issuer=%q", iss, endpoint, issuer)
		}
	}
}
