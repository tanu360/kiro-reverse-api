package proxy

import (
	"kiro-proxy/config"
	"regexp"
	"strings"
)

const defaultKiroRegion = "us-east-1"

var (
	kiroRegionPattern  = regexp.MustCompile(`^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$`)
	kiroAccountPattern = regexp.MustCompile(`^[0-9]{12}$`)
	kiroProfilePattern = regexp.MustCompile(`^[A-Za-z0-9+=,.@_-]+$`)

	//! Known Kiro data-plane regions; an explicit list keeps stored input from becoming an arbitrary outbound host.
	defaultKiroProfileRegions = []string{"us-east-1", "eu-central-1"}
)

func parseKiroProfileArn(profileArn string) (canonical, region string, ok bool) {
	//! The region lands in a hostname, so every ARN part is validated before it is trusted.
	canonical = strings.TrimSpace(profileArn)
	parts := strings.SplitN(canonical, ":", 6)
	if len(parts) != 6 ||
		parts[0] != "arn" ||
		parts[1] != "aws" ||
		parts[2] != "codewhisperer" ||
		!kiroRegionPattern.MatchString(parts[3]) ||
		!kiroAccountPattern.MatchString(parts[4]) ||
		!strings.HasPrefix(parts[5], "profile/") {
		return "", "", false
	}
	if !kiroProfilePattern.MatchString(strings.TrimPrefix(parts[5], "profile/")) {
		return "", "", false
	}
	return canonical, parts[3], true
}

func regionFromProfileArn(profileArn string) string {
	_, region, ok := parseKiroProfileArn(profileArn)
	if !ok {
		return ""
	}
	return region
}

func kiroRegionForProfile(account *config.Account, profileArn string) string {
	//! An API key has no IDE profile: its Region alone names the data plane, so a stale ARN cannot redirect it.
	if config.IsAPIKeyAccount(account) {
		if region := strings.ToLower(strings.TrimSpace(account.Region)); kiroRegionPattern.MatchString(region) {
			return region
		}
		return defaultKiroRegion
	}
	//! For OAuth accounts Region is the OAuth / OIDC region and can differ from where the profile lives.
	if region := regionFromProfileArn(profileArn); region != "" {
		return region
	}
	if account != nil {
		if region := regionFromProfileArn(account.ProfileArn); region != "" {
			return region
		}
	}
	return defaultKiroRegion
}

func regionalizeURL(rawURL string, account *config.Account) string {
	return regionalizeURLForProfile(rawURL, account, "")
}

func regionalizeURLForProfile(rawURL string, account *config.Account, profileArn string) string {
	return regionalizeURLForRegion(rawURL, kiroRegionForProfile(account, profileArn))
}

func regionalizeURLForRegion(rawURL, region string) string {
	//! The CodeWhisperer host only exists in us-east-1; other regions are served by the regional Amazon Q host.
	region = strings.ToLower(strings.TrimSpace(region))
	if region == defaultKiroRegion || !kiroRegionPattern.MatchString(region) {
		return rawURL
	}
	regionalHost := "q." + region + ".amazonaws.com"
	return strings.NewReplacer(
		"q.us-east-1.amazonaws.com", regionalHost,
		"codewhisperer.us-east-1.amazonaws.com", regionalHost,
	).Replace(rawURL)
}

func kiroProfileRegionCandidates(account *config.Account) []string {
	seen := make(map[string]struct{})
	candidates := make([]string, 0, len(defaultKiroProfileRegions)+1)
	add := func(region string) {
		region = strings.ToLower(strings.TrimSpace(region))
		if !kiroRegionPattern.MatchString(region) {
			return
		}
		if _, exists := seen[region]; exists {
			return
		}
		seen[region] = struct{}{}
		candidates = append(candidates, region)
	}
	if account != nil {
		add(regionFromProfileArn(account.ProfileArn))
	}
	for _, region := range defaultKiroProfileRegions {
		add(region)
	}
	return candidates
}
