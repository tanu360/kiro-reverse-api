package proxy

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/totp"
)

// Admin API codes of two-factor sign-in.
const (
	codeTOTPRequired         = "totp_required"
	codeTOTPInvalid          = "totp_invalid"
	codeTOTPReused           = "totp_reused"
	codeTOTPChallengeExpired = "totp_challenge_expired"
	codeTOTPSetupExpired     = "totp_setup_expired"
	codeTOTPAlreadyOn        = "totp_already_enabled"
	codeTOTPNotOn            = "totp_not_enabled"
	codeTOTPResetByEnv       = "totp_reset_by_env"
	codeTOTPProofRequired    = "totp_proof_required"
)

const (
	// totpSetupTTL is how long a QR code shown in Settings can still be confirmed.
	totpSetupTTL = 10 * time.Minute
	// totpChallengeTTL is how long the code step of a sign-in waits after the password.
	totpChallengeTTL = 5 * time.Minute
	// totpChallengeTries is how many wrong codes one password sign-in may send.
	totpChallengeTries = 5
	// maxTOTPChallenges caps memory when the password is right but no code follows.
	maxTOTPChallenges = 64
	// recoveryCodeCount is how many recovery codes enabling two-factor sign-in hands out.
	recoveryCodeCount = 10
	totpIssuer        = "Kiro Proxy"
	totpAccountName   = "admin"
)

type totpChallenge struct {
	expires  time.Time
	failures int
}

// adminTOTPState holds what two-factor sign-in keeps in memory: the secret of a
// setup not yet confirmed, and the sign-ins that passed the password and wait for a code.
type adminTOTPState struct {
	mu            sync.Mutex
	pendingSecret string
	pendingUntil  time.Time
	challenges    map[string]*totpChallenge
	// stepMu makes checking and using up a code's step one move, so two requests
	// with the same code cannot both pass.
	stepMu sync.Mutex
}

func newAdminTOTPState() *adminTOTPState {
	return &adminTOTPState{challenges: make(map[string]*totpChallenge)}
}

var adminTOTPInit sync.Mutex

// totpState is the handler's two-factor state, made on first use for handlers
// built without NewHandler.
func (h *Handler) totpState() *adminTOTPState {
	adminTOTPInit.Lock()
	defer adminTOTPInit.Unlock()
	if h.adminTOTP == nil {
		h.adminTOTP = newAdminTOTPState()
	}
	return h.adminTOTP
}

func (s *adminTOTPState) issueChallenge(now time.Time) (string, time.Time, error) {
	token, err := newSecret()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := now.Add(totpChallengeTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, c := range s.challenges {
		if now.After(c.expires) {
			delete(s.challenges, id)
		}
	}
	for len(s.challenges) >= maxTOTPChallenges {
		oldest, oldestAt := "", time.Time{}
		for id, c := range s.challenges {
			if oldest == "" || c.expires.Before(oldestAt) {
				oldest, oldestAt = id, c.expires
			}
		}
		delete(s.challenges, oldest)
	}
	s.challenges[token] = &totpChallenge{expires: expires}
	return token, expires, nil
}

func (s *adminTOTPState) challengeValid(token string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.challenges[token]
	if !ok {
		return false
	}
	if now.After(c.expires) || c.failures >= totpChallengeTries {
		delete(s.challenges, token)
		return false
	}
	return true
}

func (s *adminTOTPState) challengeFailed(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.challenges[token]; ok {
		c.failures++
		if c.failures >= totpChallengeTries {
			delete(s.challenges, token)
		}
	}
}

func (s *adminTOTPState) consumeChallenge(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.challenges, token)
}

func (s *adminTOTPState) clearChallenges() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.challenges = make(map[string]*totpChallenge)
}

// codeResult is how a two-factor code fared.
type codeResult int

const (
	codeWrong codeResult = iota
	codeAccepted
	codeReused
)

// acceptCode checks code against secret and uses up its step: a code is good
// once, and none older than the last one accepted is taken either.
func (s *adminTOTPState) acceptCode(secret, code string, now time.Time) codeResult {
	if secret == "" {
		return codeWrong
	}
	step, ok := totp.Match(secret, code, now)
	if !ok {
		return codeWrong
	}
	s.stepMu.Lock()
	defer s.stepMu.Unlock()
	last, err := config.AdminTOTPLastStep()
	if err != nil {
		logger.Warnf("[Admin] Failed to read the last two-factor step: %v", err)
		return codeWrong
	}
	if step <= last {
		return codeReused
	}
	if err := config.SetAdminTOTPLastStep(step); err != nil {
		logger.Warnf("[Admin] Failed to save the last two-factor step: %v", err)
		return codeWrong
	}
	return codeAccepted
}

// checkSecondFactor verifies a code or a recovery code under the admin guess
// limiter: a wrong one uses a guess, a right one gives it back. It writes the
// error itself and reports whether the factor passed.
func (h *Handler) checkSecondFactor(w http.ResponseWriter, r *http.Request, code, recoveryCode string) bool {
	result := codeWrong
	usedRecovery := false
	valid, delay := h.adminGuesses.check(adminRemoteHost(r), time.Now(), func() bool {
		if strings.TrimSpace(code) != "" {
			result = h.totpState().acceptCode(config.GetAdminTOTPSecret(), code, time.Now())
			return result == codeAccepted
		}
		ok, err := config.ConsumeAdminTOTPRecovery(recoveryCode)
		if err != nil {
			logger.Warnf("[Admin] Failed to use a recovery code: %v", err)
		}
		usedRecovery = ok
		return ok
	})
	if delay > 0 {
		writeGuessLimited(w, delay, "Too many two-factor attempts; try again later")
		return false
	}
	if !valid {
		w.Header().Set("Content-Type", "application/json")
		if result == codeReused {
			writeAdminError(w, http.StatusUnauthorized, codeTOTPReused, "This two-factor code was used already; wait for the next one")
		} else {
			writeAdminError(w, http.StatusUnauthorized, codeTOTPInvalid, "Invalid two-factor code")
		}
		return false
	}
	if usedRecovery {
		logger.Warnf("[Admin] Signed in with a recovery code; %d left", config.GetAdminTOTPStatus().RecoveryCodes)
	}
	return true
}

func writeGuessLimited(w http.ResponseWriter, delay time.Duration, message string) {
	w.Header().Set("Retry-After", strconv.FormatInt(int64((delay+time.Second-1)/time.Second), 10))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// newRecoveryCodes makes recoveryCodeCount codes such as "k7xq2-m9fd4" and their hashes.
func newRecoveryCodes() ([]string, []string, error) {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	codes := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)
	buf := make([]byte, 10)
	for len(codes) < recoveryCodeCount {
		if _, err := rand.Read(buf); err != nil {
			return nil, nil, err
		}
		var b strings.Builder
		for i, v := range buf {
			if i == 5 {
				b.WriteByte('-')
			}
			b.WriteByte(alphabet[int(v)%len(alphabet)])
		}
		code := b.String()
		codes = append(codes, code)
		hashes = append(hashes, config.HashRecoveryCode(code))
	}
	return codes, hashes, nil
}

// handleTwoFactorAPI serves /admin/api/two-factor/...; sub is the path after /two-factor.
func (h *Handler) handleTwoFactorAPI(w http.ResponseWriter, r *http.Request, sub string) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	switch {
	case (sub == "" || sub == "/") && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(config.GetAdminTOTPStatus())
	case sub == "/setup" && r.Method == http.MethodPost:
		h.apiTwoFactorSetup(w)
	case sub == "/enable" && r.Method == http.MethodPost:
		h.apiTwoFactorEnable(w, r)
	case sub == "/disable" && r.Method == http.MethodPost:
		h.apiTwoFactorDisable(w, r)
	case sub == "/recovery-codes" && r.Method == http.MethodPost:
		h.apiTwoFactorRecoveryCodes(w, r)
	default:
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
	}
}

// apiTwoFactorSetup starts enrolment: a new secret, its otpauth:// link and the
// QR code. Nothing changes until a code from the app confirms it.
func (h *Handler) apiTwoFactorSetup(w http.ResponseWriter) {
	if config.AdminTOTPEnabled() {
		writeAdminError(w, http.StatusConflict, codeTOTPAlreadyOn, "two-factor sign-in is already on")
		return
	}
	if config.AdminTOTPResetRequested() {
		writeAdminError(w, http.StatusConflict, codeTOTPResetByEnv, config.ResetAdminTOTPEnv+" is set, so the next start would turn two-factor sign-in off again; remove it first")
		return
	}
	secret, err := totp.NewSecret()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	uri := totp.URI(totpIssuer, totpAccountName, secret)
	svg, err := totp.QRSVG(uri)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	expires := time.Now().Add(totpSetupTTL)
	h.totpState().mu.Lock()
	h.totpState().pendingSecret, h.totpState().pendingUntil = secret, expires
	h.totpState().mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"secret":     secret,
		"otpauthUrl": uri,
		"qrSvg":      svg,
		"issuer":     totpIssuer,
		"account":    totpAccountName,
		"expiresAt":  expires.UnixMilli(),
	})
}

// apiTwoFactorEnable confirms the setup with a code from the app, turns
// two-factor sign-in on, ends every other admin session, and returns the
// recovery codes: the only time they are shown.
func (h *Handler) apiTwoFactorEnable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if config.AdminTOTPEnabled() {
		writeAdminError(w, http.StatusConflict, codeTOTPAlreadyOn, "two-factor sign-in is already on")
		return
	}
	now := time.Now()
	h.totpState().mu.Lock()
	secret, until := h.totpState().pendingSecret, h.totpState().pendingUntil
	h.totpState().mu.Unlock()
	if secret == "" || now.After(until) {
		writeAdminError(w, http.StatusBadRequest, codeTOTPSetupExpired, "the setup expired; start it again")
		return
	}
	var step int64
	matched := false
	valid, delay := h.adminGuesses.check(adminRemoteHost(r), now, func() bool {
		step, matched = totp.Match(secret, req.Code, now)
		return matched
	})
	if delay > 0 {
		writeGuessLimited(w, delay, "Too many two-factor attempts; try again later")
		return
	}
	if !valid {
		writeAdminError(w, http.StatusBadRequest, codeTOTPInvalid, "Invalid two-factor code")
		return
	}
	codes, hashes, err := newRecoveryCodes()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if err := config.EnableAdminTOTP(secret, hashes, now.UnixMilli(), step); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	h.totpState().mu.Lock()
	h.totpState().pendingSecret, h.totpState().pendingUntil = "", time.Time{}
	h.totpState().mu.Unlock()
	//! Whoever holds another session signed in without a code; this one just proved it.
	h.adminSessions.RevokeAllExcept(r.Header.Get("X-Admin-Token"))
	logger.Infof("[Admin] Two-factor sign-in turned on")
	publishEvent(eventSettingsChanged, "two-factor")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"status": config.GetAdminTOTPStatus(), "recoveryCodes": codes})
}

type twoFactorProof struct {
	Code         string `json:"code"`
	RecoveryCode string `json:"recoveryCode"`
	Password     string `json:"password"`
}

// proveAdmin checks the proof a change to two-factor sign-in needs: a current
// code, a recovery code, or (when allowPassword) the admin password.
func (h *Handler) proveAdmin(w http.ResponseWriter, r *http.Request, proof twoFactorProof, allowPassword bool) bool {
	switch {
	case strings.TrimSpace(proof.Code) != "" || strings.TrimSpace(proof.RecoveryCode) != "":
		return h.checkSecondFactor(w, r, proof.Code, proof.RecoveryCode)
	case allowPassword && proof.Password != "":
		return h.checkAdminPassword(w, r, proof.Password)
	default:
		message := "send a current two-factor code"
		if allowPassword {
			message = "send a current two-factor code or the admin password"
		}
		writeAdminError(w, http.StatusBadRequest, codeTOTPProofRequired, message)
		return false
	}
}

// apiTwoFactorDisable turns two-factor sign-in off on a current code or the password.
func (h *Handler) apiTwoFactorDisable(w http.ResponseWriter, r *http.Request) {
	var proof twoFactorProof
	if err := json.NewDecoder(r.Body).Decode(&proof); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if !config.AdminTOTPEnabled() {
		writeAdminError(w, http.StatusConflict, codeTOTPNotOn, "two-factor sign-in is off")
		return
	}
	if !h.proveAdmin(w, r, proof, true) {
		return
	}
	if err := config.DisableAdminTOTP(); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	h.totpState().clearChallenges()
	logger.Infof("[Admin] Two-factor sign-in turned off")
	publishEvent(eventSettingsChanged, "two-factor")
	json.NewEncoder(w).Encode(config.GetAdminTOTPStatus())
}

// apiTwoFactorRecoveryCodes replaces the recovery codes on a current code.
func (h *Handler) apiTwoFactorRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	var proof twoFactorProof
	if err := json.NewDecoder(r.Body).Decode(&proof); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if !config.AdminTOTPEnabled() {
		writeAdminError(w, http.StatusConflict, codeTOTPNotOn, "two-factor sign-in is off")
		return
	}
	proof.RecoveryCode = ""
	if !h.proveAdmin(w, r, proof, false) {
		return
	}
	codes, hashes, err := newRecoveryCodes()
	if err == nil {
		err = config.ReplaceAdminTOTPRecovery(hashes)
	}
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	logger.Infof("[Admin] Two-factor recovery codes replaced")
	publishEvent(eventSettingsChanged, "two-factor")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"status": config.GetAdminTOTPStatus(), "recoveryCodes": codes})
}
