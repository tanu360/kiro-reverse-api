package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"kiro-proxy/logger"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const (
	maxRemoteImageBytes      = 10 << 20
	maxRemoteImageTotalBytes = 24 << 20
	remoteImageFetchTimeout  = 30 * time.Second
)

var nonPublicImagePrefixes = func() []netip.Prefix {
	// Cloud metadata, shared address space, documentation, benchmarking and
	// transition ranges are not public image hosts.
	var prefixes []netip.Prefix
	for _, cidr := range []string{"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32", "2002::/16", "64:ff9b::/96"} {
		prefixes = append(prefixes, netip.MustParsePrefix(cidr))
	}
	return prefixes
}()

// remoteImageAddrAllowed is a variable so tests can reach httptest servers.
var remoteImageAddrAllowed = publicImageIP

func publicImageIP(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range nonPublicImagePrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func fetchRemoteImage(ctx context.Context, raw string) (string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return "", "", fmt.Errorf("image URL must be a public HTTP or HTTPS URL without credentials")
	}
	//! Every dial (redirects included) is pinned to addresses checked here, so a
	//! hostname cannot re-resolve to an internal address after the check.
	transport := &http.Transport{TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, fmt.Errorf("image host lookup failed")
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("image host has no address")
		}
		for _, ip := range ips {
			if !remoteImageAddrAllowed(ip) {
				return nil, fmt.Errorf("image URL resolves to a non-public address")
			}
		}
		d := net.Dialer{Timeout: 10 * time.Second}
		var last error
		for _, ip := range ips {
			conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			last = err
		}
		return nil, last
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || (req.URL.Scheme != "http" && req.URL.Scheme != "https") || req.URL.User != nil {
			return fmt.Errorf("unsupported image redirect")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return "", "", fmt.Errorf("invalid image URL")
	}
	r, err := client.Do(req)
	if err != nil {
		if u, ok := err.(*url.Error); ok {
			err = u.Err
		}
		return "", "", fmt.Errorf("image URL could not be fetched: %v", err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("image URL returned HTTP %d", r.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxRemoteImageBytes+1))
	if err != nil {
		return "", "", fmt.Errorf("image download failed")
	}
	if len(data) > maxRemoteImageBytes {
		return "", "", fmt.Errorf("URL image exceeds the 10 MiB limit")
	}
	media := http.DetectContentType(data)
	if media != "image/png" && media != "image/jpeg" && media != "image/gif" && media != "image/webp" {
		return "", "", fmt.Errorf("URL did not return a supported PNG, JPEG, GIF or WebP image")
	}
	return base64.StdEncoding.EncodeToString(data), media, nil
}

// inlineRemoteImages downloads http(s) image URLs in recognized image blocks
// (Anthropic url sources, OpenAI image_url, Responses input_image) and rewrites
// them as inline base64, since Kiro only accepts image bytes. Text, tool inputs
// and schemas are never inspected. A failed download leaves that block as it
// was, so the request behaves as it did before URL images were supported.
func inlineRemoteImages(ctx context.Context, body []byte) []byte {
	if !bytes.Contains(body, []byte(`"url"`)) && !bytes.Contains(body, []byte(`"image_url"`)) {
		return body
	}
	var root map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil {
		return body
	}
	var trailing interface{}
	if decoder.Decode(&trailing) != io.EOF {
		return body
	}

	ctx, cancel := context.WithTimeout(ctx, remoteImageFetchTimeout)
	defer cancel()
	changed := false
	total := 0
	var walk func(interface{})
	walk = func(value interface{}) {
		switch node := value.(type) {
		case []interface{}:
			for _, child := range node {
				walk(child)
			}
		case map[string]interface{}:
			kind := firstString(node["type"])
			if kind == "image" || kind == "image_url" || kind == "input_image" {
				raw := remoteImageURL(node)
				if raw == "" || strings.HasPrefix(raw, "data:") {
					return
				}
				data, media, err := fetchRemoteImage(ctx, raw)
				if err == nil && total+len(data) > maxRemoteImageTotalBytes {
					err = fmt.Errorf("downloaded images exceed the %d MiB request budget", maxRemoteImageTotalBytes>>20)
				}
				if err != nil {
					logger.Warnf("[RemoteImage] Skipping image URL: %v", err)
					return
				}
				total += len(data)
				if kind == "image" {
					node["source"] = map[string]interface{}{"type": "base64", "media_type": media, "data": data}
				} else if image, ok := node["image_url"].(map[string]interface{}); ok {
					image["url"] = "data:" + media + ";base64," + data
				} else {
					node["image_url"] = "data:" + media + ";base64," + data
				}
				delete(node, "url")
				changed = true
				return
			}
			// Tool calls and tool definitions are not message content.
			if kind == "tool_use" || kind == "function" {
				return
			}
			for _, key := range []string{"messages", "input", "content", "system"} {
				if child, ok := node[key]; ok {
					walk(child)
				}
			}
		}
	}
	walk(root)
	if !changed {
		return body
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return body
	}
	return encoded
}

func remoteImageURL(node map[string]interface{}) string {
	if source, ok := node["source"].(map[string]interface{}); ok {
		if firstString(source["type"]) == "url" {
			return strings.TrimSpace(firstString(source["url"]))
		}
		return ""
	}
	if image, ok := node["image_url"].(map[string]interface{}); ok {
		return strings.TrimSpace(firstString(image["url"]))
	}
	return strings.TrimSpace(firstString(node["image_url"], node["url"]))
}
