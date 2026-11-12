package auth

import "kiro-proxy/config"

// oidcRefreshRegion is the AWS OIDC region a Builder ID / IAM Identity Center refresh
// goes to: the global authRegion override when set, else the account's own region.
// Social and external-IdP refreshes have fixed hosts and never call this.
func oidcRefreshRegion(account *config.Account) string {
	if region := config.GetAuthRegionOverride(); region != "" {
		return region
	}
	if account == nil {
		return ""
	}
	return account.Region
}
