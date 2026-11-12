package config

import (
	"errors"
	"strings"
)

// API domains for the Kiro data plane (chat streaming and MCP).
const (
	// APIDomainAmazonaws sends data-plane calls to q.{region}.amazonaws.com (and
	// codewhisperer.us-east-1.amazonaws.com), as the proxy always has.
	APIDomainAmazonaws = "amazonaws"
	// APIDomainKiro sends them to runtime.{region}.kiro.dev, the host newer Kiro clients use.
	APIDomainKiro = "kiro"
)

var ErrInvalidAPIDomain = errors.New("invalid apiDomain, must be: amazonaws or kiro")

// UpstreamConfig is the global upstream host choice and the two region overrides.
// An empty region means "no override".
type UpstreamConfig struct {
	APIDomain  string
	AuthRegion string
	APIRegion  string
}

// NormalizeAPIDomain trims and lower-cases s; an empty value is the default domain.
func NormalizeAPIDomain(s string) (string, error) {
	switch d := strings.ToLower(strings.TrimSpace(s)); d {
	case "":
		return APIDomainAmazonaws, nil
	case APIDomainAmazonaws, APIDomainKiro:
		return d, nil
	default:
		return "", ErrInvalidAPIDomain
	}
}

// NormalizeAuthRegionOverride keeps "" (no override) and otherwise requires a plain
// AWS region code: IAM Identity Center can live in any region.
func NormalizeAuthRegionOverride(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	return NormalizeAWSRegion(s)
}

// NormalizeAPIRegionOverride keeps "" (no override) and otherwise requires a region
// Kiro serves its data plane from; other regions name hosts that do not resolve.
func NormalizeAPIRegionOverride(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return "", nil
	}
	if !IsKiroServiceRegion(s) {
		return "", ErrInvalidRegion
	}
	return s, nil
}

// GetAPIDomain returns the stored API domain, or amazonaws when none (or an invalid one) is stored.
func GetAPIDomain() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return apiDomainLocked()
}

// GetAuthRegionOverride returns the region every OIDC token refresh uses, or "" to
// use each account's own region.
func GetAuthRegionOverride() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return authRegionLocked()
}

// GetAPIRegionOverride returns the region every data-plane and REST call uses, or ""
// to take it from each account's profile.
func GetAPIRegionOverride() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return apiRegionLocked()
}

// GetUpstreamConfig returns the effective upstream settings in one read.
func GetUpstreamConfig() UpstreamConfig {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return UpstreamConfig{
		APIDomain:  apiDomainLocked(),
		AuthRegion: authRegionLocked(),
		APIRegion:  apiRegionLocked(),
	}
}

// UpdateUpstreamConfig validates and stores all three values; the caller merges a partial update first.
func UpdateUpstreamConfig(u UpstreamConfig) error {
	domain, err := NormalizeAPIDomain(u.APIDomain)
	if err != nil {
		return err
	}
	authRegion, err := NormalizeAuthRegionOverride(u.AuthRegion)
	if err != nil {
		return err
	}
	apiRegion, err := NormalizeAPIRegionOverride(u.APIRegion)
	if err != nil {
		return err
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	//! The default is stored as "", so an unchanged install keeps an unchanged config blob.
	if domain == APIDomainAmazonaws {
		domain = ""
	}
	cfg.APIDomain = domain
	cfg.AuthRegion = authRegion
	cfg.APIRegion = apiRegion
	return Save()
}

//! The getters re-validate stored values: a hand-edited or restored config must never put an arbitrary host into a URL.

func apiDomainLocked() string {
	if cfg == nil {
		return APIDomainAmazonaws
	}
	domain, err := NormalizeAPIDomain(cfg.APIDomain)
	if err != nil {
		return APIDomainAmazonaws
	}
	return domain
}

func authRegionLocked() string {
	if cfg == nil {
		return ""
	}
	region, err := NormalizeAuthRegionOverride(cfg.AuthRegion)
	if err != nil {
		return ""
	}
	return region
}

func apiRegionLocked() string {
	if cfg == nil {
		return ""
	}
	region, err := NormalizeAPIRegionOverride(cfg.APIRegion)
	if err != nil {
		return ""
	}
	return region
}
