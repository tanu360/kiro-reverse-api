package proxypool

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"kiro-proxy/config"
)

const (
	// MaxProxies caps the pool; a health check of all of them stays well under a minute.
	MaxProxies = 100
	// MaxLabelRunes is the longest label the UI shows on one line.
	MaxLabelRunes = 64
	// maxCredentialBytes bounds a username or password.
	maxCredentialBytes = 255
)

var (
	ErrDuplicate = errors.New("this proxy is already in the pool")
	ErrFull      = errors.New("the proxy pool is full")
	ErrNotFound  = errors.New("proxy not found")
)

// InputError is a proxy the admin API refuses; Reason is English and names the field.
type InputError struct{ Reason string }

func (e *InputError) Error() string { return "invalid proxy: " + e.Reason }

func invalid(reason string) error { return &InputError{Reason: reason} }

// ProxyInput is an add or an edit. A nil field keeps the stored value on an edit;
// an empty Password clears it. A URL with user:pass@ fills the sign-in unless
// Username or Password is given as well.
type ProxyInput struct {
	Label    *string
	URL      *string
	Username *string
	Password *string
}

// parseProxyURL validates raw and returns scheme://host:port plus any userinfo it held.
func parseProxyURL(raw string) (base, user, pass string, hasUser bool, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", "", false, invalid("url is required")
	}
	u, parseErr := url.Parse(raw)
	if parseErr != nil || u.Opaque != "" {
		return "", "", "", false, invalid("url is not a valid proxy URL")
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return "", "", "", false, invalid("url must start with http://, https://, socks5:// or socks5h://")
	}
	host := u.Hostname()
	if host == "" {
		return "", "", "", false, invalid("url needs a host")
	}
	port := u.Port()
	if port == "" {
		return "", "", "", false, invalid("url needs a port")
	}
	if n, convErr := strconv.Atoi(port); convErr != nil || n < 1 || n > 65535 {
		return "", "", "", false, invalid("port must be from 1 to 65535")
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", "", "", false, invalid("url must not have a path or query")
	}
	base = scheme + "://" + net.JoinHostPort(strings.ToLower(host), port)
	if u.User != nil {
		user = u.User.Username()
		pass, _ = u.User.Password()
		hasUser = true
	}
	return base, user, pass, hasUser, nil
}

// buildProxy applies in to base (nil for a new proxy) and validates the result.
func buildProxy(in ProxyInput, base *config.PoolProxy) (config.PoolProxy, error) {
	var p config.PoolProxy
	if base != nil {
		p = *base
	}
	if in.URL != nil {
		stored, user, pass, hasUser, err := parseProxyURL(*in.URL)
		if err != nil {
			return config.PoolProxy{}, err
		}
		p.URL = stored
		if hasUser {
			p.Username, p.Password = user, pass
		}
	} else if base == nil {
		return config.PoolProxy{}, invalid("url is required")
	}
	if in.Username != nil {
		p.Username = strings.TrimSpace(*in.Username)
	}
	if in.Password != nil {
		p.Password = *in.Password
	}
	if in.Label != nil {
		p.Label = strings.TrimSpace(*in.Label)
	}
	if utf8.RuneCountInString(p.Label) > MaxLabelRunes {
		return config.PoolProxy{}, invalid("label must be at most 64 characters")
	}
	if strings.IndexFunc(p.Label, unicode.IsControl) >= 0 {
		return config.PoolProxy{}, invalid("label must not contain control characters")
	}
	if len(p.Username) > maxCredentialBytes || len(p.Password) > maxCredentialBytes {
		return config.PoolProxy{}, invalid("username and password must be at most 255 bytes")
	}
	if p.Password != "" && p.Username == "" {
		return config.PoolProxy{}, invalid("a password needs a username")
	}
	return p, nil
}

// identity is what makes two proxies the same: scheme, host, port and user.
func identity(p config.PoolProxy) string {
	return p.URL + "|" + p.Username
}

// FullURL is the URL a transport dials, sign-in included. It must never reach a
// log line or an API response; use DisplayURL there.
func FullURL(p config.PoolProxy) string {
	if p.Username == "" && p.Password == "" {
		return p.URL
	}
	scheme, hostPort, ok := strings.Cut(p.URL, "://")
	if !ok {
		return p.URL
	}
	var info *url.Userinfo
	if p.Password == "" {
		info = url.User(p.Username)
	} else {
		info = url.UserPassword(p.Username, p.Password)
	}
	return scheme + "://" + info.String() + "@" + hostPort
}

// DisplayURL is the proxy address without any sign-in.
func DisplayURL(p config.PoolProxy) string {
	return p.URL
}

// Name is the label, or the address when the proxy has none.
func Name(p config.PoolProxy) string {
	if p.Label != "" {
		return p.Label
	}
	return DisplayURL(p)
}

var userinfoPattern = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/@\s]*@`)

const maxErrorRunes = 300

// Redact strips every URL sign-in and the proxy's own password from s and caps
// it, so an error text can be stored and shown.
func Redact(s string, p config.PoolProxy) string {
	s = userinfoPattern.ReplaceAllString(s, "$1***@")
	if p.Password != "" {
		for _, form := range []string{p.Password, url.QueryEscape(p.Password), url.PathEscape(p.Password), url.UserPassword("", p.Password).String()[1:]} {
			if form != "" {
				s = strings.ReplaceAll(s, form, "***")
			}
		}
	}
	if utf8.RuneCountInString(s) > maxErrorRunes {
		runes := []rune(s)
		s = string(runes[:maxErrorRunes-1]) + "…"
	}
	return s
}
