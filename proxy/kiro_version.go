package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// kiroMetadataURL is the Kiro IDE's own update feed for its stable channel; currentRelease is
// the version every IDE updates to.
const kiroMetadataURL = "https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json"

// kiroVersionEvery is how often the feed is read: Kiro ships an IDE build every week or two.
const kiroVersionEvery = 6 * time.Hour

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
