package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"kiro-proxy/config"
)

func (h *Handler) apiEventsStream(w http.ResponseWriter, r *http.Request) {
	password := ""
	if cookie, _ := r.Cookie("admin_password"); cookie != nil {
		password = cookie.Value
		if decoded, err := url.QueryUnescape(password); err == nil {
			password = decoded
		}
	}

	if password != config.GetPassword() {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	id, ch := getBroadcaster().Subscribe()
	defer getBroadcaster().Unsubscribe(id)

	fmt.Fprintf(w, "event: hello\ndata: {}\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case evt, ok := <-ch:
			if !ok {
				return
			}
			payload, _ := json.Marshal(evt)
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, payload); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
