package config

import (
	"strconv"
	"strings"
	"sync/atomic"
)

// latestKiroVersion is the Kiro IDE's current stable release as Kiro publishes it
// (proxy/kiro_version.go fetches it); empty until a fetch succeeds.
var latestKiroVersion atomic.Pointer[string]

// SetLatestKiroVersion records Kiro's current stable release, which requests then advertise
// unless config.kiroVersion overrides it. A version that does not parse, or is not newer than
// the built-in one, is ignored, so a bad fetch can never move the proxy back. It reports
// whether the advertised version changed.
func SetLatestKiroVersion(version string) bool {
	version = strings.TrimSpace(version)
	if !newerKiroVersion(version, defaultKiroVersion) {
		return false
	}
	if old := latestKiroVersion.Load(); old != nil && !newerKiroVersion(version, *old) {
		return false
	}
	latestKiroVersion.Store(&version)
	return true
}

// advertisedKiroVersion is the latest fetched release when there is one, else the built-in one.
func advertisedKiroVersion() string {
	if v := latestKiroVersion.Load(); v != nil {
		return *v
	}
	return defaultKiroVersion
}

// newerKiroVersion reports whether a is a dotted numeric version ("1.4.178") above b.
func newerKiroVersion(a, b string) bool {
	pa, ok := parseKiroVersion(a)
	if !ok {
		return false
	}
	pb, ok := parseKiroVersion(b)
	if !ok {
		return true
	}
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// parseKiroVersion splits "1.4.178" into its numbers: two to four of them, each 0 to 99999.
func parseKiroVersion(v string) ([]int, bool) {
	parts := strings.Split(v, ".")
	if len(parts) < 2 || len(parts) > 4 {
		return nil, false
	}
	nums := make([]int, len(parts))
	for i, p := range parts {
		if p == "" || len(p) > 5 {
			return nil, false
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || strconv.Itoa(n) != p {
			return nil, false
		}
		nums[i] = n
	}
	return nums, true
}
