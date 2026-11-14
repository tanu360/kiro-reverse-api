// Package totp implements RFC 6238 time-based one-time passwords (HMAC-SHA1,
// six digits, 30-second steps), as authenticator apps generate them, and the
// otpauth:// URI and QR code that enroll a secret in one.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	// Digits is the length of a code.
	Digits = 6
	// Period is how long one code lasts.
	Period = 30 * time.Second
	// Skew is how many steps either side of now a code may come from, for a
	// phone whose clock is a little off.
	Skew = 1
	// secretBytes is RFC 4226's recommended 160-bit secret.
	secretBytes = 20
)

var (
	ErrBadSecret = errors.New("totp: secret is not valid base32")
	encoding     = base32.StdEncoding.WithPadding(base32.NoPadding)
)

// NewSecret returns a random secret in unpadded base32, as apps accept it.
func NewSecret() (string, error) {
	buf := make([]byte, secretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("totp: generate secret: %w", err)
	}
	return encoding.EncodeToString(buf), nil
}

func decodeSecret(secret string) ([]byte, error) {
	clean := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(secret), " ", ""))
	clean = strings.TrimRight(clean, "=")
	key, err := encoding.DecodeString(clean)
	if err != nil || len(key) == 0 {
		return nil, ErrBadSecret
	}
	return key, nil
}

// Step is the time step that t falls in.
func Step(t time.Time) int64 {
	return t.Unix() / int64(Period/time.Second)
}

// CodeAt is the code for one time step (RFC 4226 HOTP over the step counter).
func CodeAt(secret string, step int64) (string, error) {
	key, err := decodeSecret(secret)
	if err != nil {
		return "", err
	}
	return hotp(key, uint64(step), Digits), nil
}

func hotp(key []byte, counter uint64, digits int) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%mod)
}

// Match finds the step a code was made for, within Skew steps of now. It
// returns the step and true for a match; the caller refuses a step it has
// accepted before, so a code works once. Non-digits in code are ignored.
func Match(secret, code string, now time.Time) (int64, bool) {
	code = normalizeCode(code)
	if len(code) != Digits {
		return 0, false
	}
	key, err := decodeSecret(secret)
	if err != nil {
		return 0, false
	}
	current := Step(now)
	matched, found := int64(0), false
	//! Every step is computed and compared, so the time taken says nothing about which one matched.
	for delta := int64(-Skew); delta <= Skew; delta++ {
		want := hotp(key, uint64(current+delta), Digits)
		if hmac.Equal([]byte(want), []byte(code)) && !found {
			matched, found = current+delta, true
		}
	}
	return matched, found
}

func normalizeCode(code string) string {
	var b strings.Builder
	for _, r := range code {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else if r != ' ' && r != '-' {
			return ""
		}
	}
	return b.String()
}

// URI is the otpauth:// link an authenticator app enrolls the secret from.
func URI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(Digits))
	q.Set("period", fmt.Sprint(int(Period/time.Second)))
	return "otpauth://totp/" + label + "?" + q.Encode()
}
