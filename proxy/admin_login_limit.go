package proxy

import (
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const adminGuessWindow = time.Minute
const adminGuessesPerClient = 5

// Past adminGuessesGlobal failures in a window, every client drops to
// adminGuessesUnderAttack tries instead of being locked out, so a distributed
// attack slows down without shutting the real admin out.
const adminGuessesGlobal = 30
const adminGuessesUnderAttack = 1
const maxAdminGuessClients = 65536

type adminGuessBucket struct {
	count int
	until time.Time
}
type adminGuessLimiter struct {
	mu      sync.Mutex
	clients map[string]adminGuessBucket
	global  adminGuessBucket
}

func adminRemoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.To4() == nil {
			//! One IPv6 host usually owns a whole /64; per-address buckets would let it rotate freely.
			return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
		}
		return ip.String()
	}
	return host
}

// Check and count guesses under one lock so parallel failures cannot bypass the budget.
func (l *adminGuessLimiter) allow(host string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.allowLocked(host, now)
}
func (l *adminGuessLimiter) allowLocked(host string, now time.Time) time.Duration {
	if l.clients == nil {
		l.clients = make(map[string]adminGuessBucket)
	}
	if !now.Before(l.global.until) {
		l.global = adminGuessBucket{until: now.Add(adminGuessWindow)}
	}
	b := l.clients[host]
	if !now.Before(b.until) {
		b = adminGuessBucket{until: now.Add(adminGuessWindow)}
	}
	limit := adminGuessesPerClient
	if l.global.count >= adminGuessesGlobal {
		limit = adminGuessesUnderAttack
	}
	if b.count >= limit {
		return b.until.Sub(now)
	}
	if len(l.clients) >= maxAdminGuessClients {
		for key, bucket := range l.clients {
			if !now.Before(bucket.until) {
				delete(l.clients, key)
			}
		}
		if _, ok := l.clients[host]; !ok && len(l.clients) >= maxAdminGuessClients {
			return adminGuessWindow
		}
	}
	b.count++
	l.global.count++
	l.clients[host] = b
	return 0
}

func (l *adminGuessLimiter) checkPassword(host, password string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if delay := l.allowLocked(host, now); delay > 0 {
		return false, delay
	}
	if !adminPasswordMatches(password) {
		return false, 0
	}
	// Valid scripts may poll with a password header; only failures consume budget.
	bucket := l.clients[host]
	bucket.count--
	l.clients[host] = bucket
	l.global.count--
	return true, 0
}
func (h *Handler) checkAdminPassword(w http.ResponseWriter, r *http.Request, password string) bool {
	valid, delay := h.adminGuesses.checkPassword(adminRemoteHost(r), password, time.Now())
	if delay > 0 {
		w.Header().Set("Retry-After", strconv.FormatInt(int64((delay+time.Second-1)/time.Second), 10))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"error": "Too many admin password attempts; try again later"})
		return false
	}
	if !valid {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
	}
	return valid
}
