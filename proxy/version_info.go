package proxy

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"sync"

	"kiro-proxy/config"
)

// versionInfo is GET /admin/api/version: the running version, and what the update dialog needs
// to show the right way to update this server. os and arch name the release archive
// (kiro-proxy_<os>_<arch>), and docker says the server runs in a container, where the Docker
// steps apply instead of a binary download.
type versionInfo struct {
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	Docker  bool   `json:"docker"`
}

// containerMarkers are files a container runtime puts in the root of every container: Docker
// writes /.dockerenv and Podman /run/.containerenv.
var containerMarkers = []string{"/.dockerenv", "/run/.containerenv"}

// inContainer reports whether any of the marker files exists.
func inContainer(markers []string) bool {
	for _, marker := range markers {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return false
}

// runsInContainer is checked once: a process does not move in or out of a container.
var runsInContainer = sync.OnceValue(func() bool { return inContainer(containerMarkers) })

func currentVersionInfo() versionInfo {
	return versionInfo{
		Version: config.Version,
		OS:      runtime.GOOS,
		Arch:    runtime.GOARCH,
		Docker:  runsInContainer(),
	}
}

func (h *Handler) apiGetVersion(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(currentVersionInfo())
}
