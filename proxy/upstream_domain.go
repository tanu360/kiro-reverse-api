package proxy

import (
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/url"
	"strings"
)

// kiroDataPlaneHost is the chat / MCP host for region under the global apiDomain setting.
func kiroDataPlaneHost(region string) string {
	if config.GetAPIDomain() == config.APIDomainKiro {
		return "runtime." + region + ".kiro.dev"
	}
	return "q." + region + ".amazonaws.com"
}

// applyAPIDomain moves an IDE data-plane URL (already regionalised) to runtime.{region}.kiro.dev
// when apiDomain is kiro. Path, query, X-Amz-Target and headers stay the same, so the endpoint
// preference and fallback work on either domain. Other hosts and the amazonaws mode pass through.
func applyAPIDomain(rawURL, region string) string {
	if config.GetAPIDomain() != config.APIDomainKiro {
		return rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil || !isAmazonawsDataPlaneHost(u.Host) {
		return rawURL
	}
	region = strings.ToLower(strings.TrimSpace(region))
	if !kiroRegionPattern.MatchString(region) {
		region = defaultKiroRegion
	}
	u.Host = kiroDataPlaneHost(region)
	return u.String()
}

// regionOverrideMismatch reports whether a global region override sends this account's calls
// somewhere other than its own region. Kiro answers a wrong data-plane region with 403
// "Invalid token" and a wrong OIDC region fails the refresh, so an auth error then says nothing
// about the account. A ban would outlive clearing the override, so callers only cool it.
func regionOverrideMismatch(account *config.Account) bool {
	if account == nil {
		return false
	}
	if region := config.GetAPIRegionOverride(); region != "" && region != kiroAccountRegion(account, "") {
		return true
	}
	return auth.AuthRegionOverrideMismatch(account)
}

func isAmazonawsDataPlaneHost(host string) bool {
	if host == "codewhisperer.us-east-1.amazonaws.com" {
		return true
	}
	region, ok := strings.CutPrefix(host, "q.")
	if !ok {
		return false
	}
	region, ok = strings.CutSuffix(region, ".amazonaws.com")
	return ok && kiroRegionPattern.MatchString(region)
}
