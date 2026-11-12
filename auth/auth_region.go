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

// AuthRegionOverrideMismatch reports whether the authRegion override sends this account's
// token refresh to a region other than its own. A refresh there fails however good the
// refresh token is, so the caller must not treat that failure as a dead account.
func AuthRegionOverrideMismatch(account *config.Account) bool {
	override := config.GetAuthRegionOverride()
	if override == "" || !usesOIDCRefresh(account) {
		return false
	}
	own, err := config.NormalizeAWSRegion(account.Region)
	return err != nil || own != override
}

// usesOIDCRefresh mirrors the dispatch in RefreshTokenContext: only Builder ID and
// IAM Identity Center accounts refresh through oidcRefreshRegion.
func usesOIDCRefresh(account *config.Account) bool {
	return account != nil &&
		!config.IsAPIKeyAccount(account) &&
		!config.IsExternalIdpAccount(account) &&
		account.AuthMethod != "social"
}
