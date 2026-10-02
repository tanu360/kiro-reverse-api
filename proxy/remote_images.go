package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const maxRemoteImageBytes = 10 << 20

func publicImageIP(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return false
	}
	// Cloud metadata, shared address space, documentation, benchmarking and
	// transition ranges are not public image hosts.
	for _, cidr := range []string{"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32", "2002::/16", "64:ff9b::/96"} {
		p, _ := netip.ParsePrefix(cidr)
		if p.Contains(addr) {
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
			if !publicImageIP(ip) {
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
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
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
		return "", "", fmt.Errorf("image URL could not be fetched: %s", safeRemoteImageError(err))
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
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

func safeRemoteImageError(err error) string {
	if u, ok := err.(*url.Error); ok {
		return u.Err.Error()
	}
	return err.Error()
}

// Recognized image blocks only: arbitrary user strings, tool arguments and
// URLs quoted in text are not fetched or rewritten.
func normalizeRemoteImages(ctx context.Context, body []byte) ([]byte, error) {
	var root map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil {
		return body, nil
	}
	var trailing interface{}
	if decoder.Decode(&trailing) != io.EOF {
		return body, nil
	}
	changed := false
	total := 0
	var walk func(interface{}) error
	walk = func(value interface{}) error {
		switch node := value.(type) {
		case []interface{}:
			for _, child := range node {
				if err := walk(child); err != nil {
					return err
				}
			}
		case map[string]interface{}:
			kind := firstString(node["type"])
			if kind == "image" || kind == "image_url" || kind == "input_image" {
				var raw string
				if source, ok := node["source"].(map[string]interface{}); ok && source["type"] == "url" {
					raw = firstString(source["url"])
				}
				if raw == "" {
					raw = firstString(node["image_url"], node["url"])
					if image, ok := node["image_url"].(map[string]interface{}); ok {
						raw = firstString(image["url"])
					}
				}
				if raw != "" && !strings.HasPrefix(raw, "data:") {
					data, media, err := fetchRemoteImage(ctx, raw)
					if err != nil {
						return err
					}
					total += len(data)
					if total > 24<<20 {
						return fmt.Errorf("downloaded images exceed the request image budget")
					}
					if kind == "image" {
						node["source"] = map[string]interface{}{"type": "base64", "media_type": media, "data": data}
						delete(node, "url")
					} else {
						encoded := "data:" + media + ";base64," + data
						if image, ok := node["image_url"].(map[string]interface{}); ok {
							image["url"] = encoded
						} else {
							node["image_url"] = encoded
						}
						delete(node, "url")
					}
					changed = true
				}
				return nil
			}
			// Walk message content, including nested tool results. Do not inspect
			// tool-use input or JSON schemas as message blocks.
			if kind == "tool_use" || kind == "function" {
				return nil
			}
			for _, key := range []string{"messages", "input", "content", "system"} {
				if child, ok := node[key]; ok {
					if err := walk(child); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return nil, err
	}
	if !changed {
		return body, nil
	}
	return json.Marshal(root)
}
