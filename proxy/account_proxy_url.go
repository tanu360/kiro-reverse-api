package proxy

import (
	"errors"
	"net/http"
	"strings"
)

// maskedProxyPassword stands in for a stored proxy password in admin API answers.
// Sent back unchanged in a proxy URL, it keeps the stored password.
const maskedProxyPassword = "********"

// errMaskedProxyPassword is a proxy URL that holds the mask where no password is stored.
var errMaskedProxyPassword = errors.New("proxyURL holds the masked password, but no password is saved: type the real one")

// proxyURLPasswordSpan is where the password sits in raw, as byte offsets; ok is
// false when raw has no user:password@. The userinfo ends at the last @, so a
// password with an unescaped / or @ is still found whole.
func proxyURLPasswordSpan(raw string) (start, end int, ok bool) {
	scheme := strings.Index(raw, "://")
	if scheme < 0 {
		return 0, 0, false
	}
	authStart := scheme + len("://")
	at := strings.LastIndex(raw[authStart:], "@")
	if at < 0 {
		return 0, 0, false
	}
	colon := strings.Index(raw[authStart:authStart+at], ":")
	if colon < 0 {
		return 0, 0, false
	}
	return authStart + colon + 1, authStart + at, true
}

// maskProxyURL is raw with its password, if any, swapped for maskedProxyPassword.
func maskProxyURL(raw string) string {
	start, end, ok := proxyURLPasswordSpan(raw)
	if !ok || start == end {
		return raw
	}
	return raw[:start] + maskedProxyPassword + raw[end:]
}

// restoreProxyPassword puts the stored password back where incoming holds the
// mask, so a URL read from the API can be saved again unchanged, or with only its
// host or user edited. Any other incoming URL is returned as it is.
func restoreProxyPassword(incoming, stored string) (string, error) {
	start, end, ok := proxyURLPasswordSpan(incoming)
	if !ok || incoming[start:end] != maskedProxyPassword {
		return incoming, nil
	}
	storedStart, storedEnd, storedOK := proxyURLPasswordSpan(stored)
	if !storedOK || storedStart == storedEnd {
		return "", errMaskedProxyPassword
	}
	return incoming[:start] + stored[storedStart:storedEnd] + incoming[end:], nil
}

// validProxyURLScheme reports whether raw is empty or starts with a scheme the
// outbound transports dial.
func validProxyURLScheme(raw string) bool {
	if raw == "" {
		return true
	}
	lower := strings.ToLower(raw)
	for _, scheme := range []string{"http://", "https://", "socks5://", "socks5h://"} {
		if strings.HasPrefix(lower, scheme) {
			return true
		}
	}
	return false
}

// errProxyURLScheme is a proxy URL without one of the schemes validProxyURLScheme accepts.
var errProxyURLScheme = errors.New("proxyURL must start with http://, https://, socks5://, or socks5h://")

// accountProxyURLUpdate reads "proxyURL" from an account update: trimmed,
// checked, and with a masked password swapped back for the stored one. ok is
// false when the update does not set it.
func accountProxyURLUpdate(updates map[string]interface{}, stored string) (value string, ok bool, err error) {
	raw, ok := updates["proxyURL"].(string)
	if !ok {
		return "", false, nil
	}
	value = strings.TrimSpace(raw)
	if !validProxyURLScheme(value) {
		return "", false, errProxyURLScheme
	}
	value, err = restoreProxyPassword(value, stored)
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// writeProxyURLError answers a proxy URL that accountProxyURLUpdate or
// restoreProxyPassword refused.
func writeProxyURLError(w http.ResponseWriter, err error) {
	if errors.Is(err, errMaskedProxyPassword) {
		writeAdminError(w, http.StatusBadRequest, codeProxyPasswordMasked, err.Error())
		return
	}
	writeAdminError(w, http.StatusBadRequest, codeProxyURLScheme, err.Error())
}
