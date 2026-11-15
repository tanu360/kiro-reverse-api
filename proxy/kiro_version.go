package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// kiroMetadataURL is the Kiro IDE's own update feed for its stable channel; currentRelease is
// the version every IDE updates to.
const kiroMetadataURL = "https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json"

// kiroVersionEvery is how often the feed is read: once a day, since Kiro ships an IDE build
// every week or two, and a rejection reads it sooner (noteKiroVersionGate).
const kiroVersionEvery = 24 * time.Hour

// kiroGateRecheckGap spaces the feed reads that a version-gate rejection triggers.
const kiroGateRecheckGap = 10 * time.Minute

// lastGateRecheck is when a rejection last triggered a feed read, in Unix nanoseconds.
var lastGateRecheck atomic.Int64

// kiroVersionRecheck reads the feed in the background; tests replace it.
var kiroVersionRecheck = func() { go refreshKiroVersion(kiroMetadataURL) }

// noteKiroVersionGate reads the feed again right away when Kiro refused a request for an old
// IDE version (403 FEATURE_NOT_SUPPORTED), since Kiro has shipped a build since, instead of
// waiting up to kiroVersionEvery for the next read. At most once per kiroGateRecheckGap.
func noteKiroVersionGate(body string) {
	if !strings.Contains(body, "FEATURE_NOT_SUPPORTED") {
		return
	}
	now := time.Now().UnixNano()
	last := lastGateRecheck.Load()
	if now-last < int64(kiroGateRecheckGap) || !lastGateRecheck.CompareAndSwap(last, now) {
		return
	}
	logger.Warnf("[Kiro] Kiro refused KiroIDE-%s as too old; checking for a newer Kiro IDE", config.GetKiroClientConfig().KiroVersion)
	kiroVersionRecheck()
}

// backgroundKiroVersion reads Kiro's current stable release at start and then every
// kiroVersionEvery, so requests advertise the IDE build Kiro's version gate expects
// (config.SetLatestKiroVersion). A failed read keeps the version already in use.
func (h *Handler) backgroundKiroVersion() {
	for {
		refreshKiroVersion(kiroMetadataURL)
		select {
		case <-h.stopRefresh:
			return
		case <-time.After(kiroVersionEvery):
		}
	}
}

func refreshKiroVersion(url string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	version, err := fetchKiroVersion(ctx, GetRestClientForProxy(config.GetProxyURL()), url)
	if err != nil {
		logger.Debugf("[Kiro] Could not read the Kiro IDE's current version: %v", err)
		return
	}
	if config.SetLatestKiroVersion(version) {
		logger.Infof("[Kiro] Kiro IDE %s is out; requests now say KiroIDE-%s", version, config.GetKiroClientConfig().KiroVersion)
	}
}

// fetchKiroVersion returns the feed's currentRelease ("1.4.178").
func fetchKiroVersion(ctx context.Context, client *http.Client, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var feed struct {
		CurrentRelease string `json:"currentRelease"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&feed); err != nil {
		return "", err
	}
	if feed.CurrentRelease == "" {
		return "", fmt.Errorf("no currentRelease")
	}
	return feed.CurrentRelease, nil
}
