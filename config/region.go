package config

import (
	"errors"
	"strings"

	"kiro-proxy/logger"
)

const DefaultRegion = "us-east-1"

var (
	ErrInvalidRegion = errors.New("invalid region")

	//! Kiro's data plane exists only here; other AWS regions name runtime / Q hosts that do not resolve.
	kiroServiceRegions = []string{"us-east-1", "eu-central-1"}

	ErrUnsupportedKiroAPIKeyRegion = errors.New("unsupported Kiro API key region: use " + strings.Join(kiroServiceRegions, " or "))
)

// NormalizeAWSRegion lower-cases a user-supplied region, defaults an empty one
// to us-east-1 and rejects anything that is not a plain AWS region code.
func NormalizeAWSRegion(region string) (string, error) {
	//! Regions are interpolated into AWS hostnames; anything else could send tokens and client secrets to another host.
	region = strings.ToLower(strings.TrimSpace(region))
	if region == "" {
		return DefaultRegion, nil
	}
	if !kiroAPIKeyRegionPattern.MatchString(region) {
		return "", ErrInvalidRegion
	}
	return region, nil
}

// KiroServiceRegions returns the regions Kiro serves its data plane from.
func KiroServiceRegions() []string {
	return append([]string(nil), kiroServiceRegions...)
}

func IsKiroServiceRegion(region string) bool {
	region = strings.ToLower(strings.TrimSpace(region))
	for _, served := range kiroServiceRegions {
		if region == served {
			return true
		}
	}
	return false
}

func warnUnservedAPIKeyRegions() {
	//! Already-stored keys keep working as configured; only new ones are refused.
	for _, account := range GetAccounts() {
		if IsAPIKeyAccount(&account) && !IsKiroServiceRegion(account.Region) {
			logger.Warnf("[Config] Kiro API key account %s uses region %q, which Kiro does not serve (supported: %s)",
				account.Email, account.Region, strings.Join(kiroServiceRegions, ", "))
		}
	}
}
