package proxy

import (
	"encoding/json"
	"errors"
	"net/http"

	"kiro-proxy/auth"
	"kiro-proxy/config"
)

// Codes in the JSON error body of an /admin/api route: {"error": "<English>",
// "code": "<code>"}. The admin UI translates by code (ui/src/lib/api/server-errors.ts)
// and "error" stays the English text for scripts. A code never changes once
// shipped. "detail" carries upstream text the UI shows as-is after its
// translation; other string or number fields fill the translation's placeholders.
const (
	codeInvalidJSON             = "invalid_json"
	codeAccountNotFound         = "account_not_found"
	codeAPIKeyNotFound          = "api_key_not_found"
	codeNoAccountIDs            = "no_account_ids"
	codeNotOverageCapable       = "not_overage_capable"
	codeOverageFailed           = "overage_failed"
	codeModelsRefreshFailed     = "models_refresh_failed"
	codeInvalidRegion           = "invalid_region"
	codeStartURLRequired        = "start_url_required"
	codeBearerTokenRequired     = "bearer_token_required"
	codeRefreshTokenRequired    = "refresh_token_required"
	codeKiroAPIKeyEmpty         = "kiro_api_key_empty"
	codeKiroAPIKeyInvalid       = "kiro_api_key_invalid"
	codeKiroAPIKeyRegion        = "kiro_api_key_region"
	codeKiroAPIKeyRegionUnsup   = "kiro_api_key_region_unsupported"
	codeKiroAPIKeyDuplicate     = "kiro_api_key_duplicate"
	codeTokenRefreshFailed      = "token_refresh_failed"
	codeProfileArnInvalid       = "profile_arn_invalid"
	codeProfileNotAvailable     = "profile_not_available"
	codeProfileVerifyFailed     = "profile_verify_failed"
	codeNoKiroProfile           = "no_kiro_profile"
	codeAPIKeyAccountNoProfile  = "api_key_account_no_profile"
	codeMicrosoftDuplicate      = "microsoft_duplicate"
	codeMicrosoftCredential     = "microsoft_credential_invalid"
	codeMicrosoftProfilePending = "microsoft_profile_unresolved"
	codeReloginIdentityMismatch = "relogin_identity_mismatch"
	codeReloginPendingNotFound  = "relogin_pending_not_found"
	codeReloginSingleCredential = "relogin_single_credential"
	codeAutoContinueMaxRange    = "auto_continue_max_range"
	codePasswordTooShort        = "password_too_short"
	codeInvalidEndpoint         = "invalid_endpoint"
	codeProxyURLScheme          = "proxy_url_scheme"
	codeAPIKeyEmpty             = "api_key_empty"
	codeAPIKeyExists            = "api_key_exists"
	codeAPIKeyCollision         = "api_key_collision"
	codeTokenLimitNegative      = "token_limit_negative"
	codeCreditLimitNegative     = "credit_limit_negative"
	codeBackupNotFound          = "backup_not_found"
	codeBackupUploadFailed      = "backup_upload_failed"
)

// writeAdminError writes {"error": message, "code": code} with status.
func writeAdminError(w http.ResponseWriter, status int, code, message string) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message, "code": code})
}

// writeAdminErrorDetail adds the upstream detail the UI shows after its translation.
func writeAdminErrorDetail(w http.ResponseWriter, status int, code, message, detail string) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message, "code": code, "detail": detail})
}

// writeAdminErr writes err.Error() with the code adminErrorFields finds for it,
// or with fallbackCode and the whole message as the detail. An empty fallback
// leaves an unknown error without a code.
func writeAdminErr(w http.ResponseWriter, status int, err error, fallbackCode string) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(adminErrorBody(err, fallbackCode))
}

// adminErrorBody is writeAdminErr's JSON body; callers add their own fields to it.
func adminErrorBody(err error, fallbackCode string) map[string]interface{} {
	body := map[string]interface{}{"error": err.Error()}
	if code, detail, params := adminErrorFields(err); code != "" {
		body["code"] = code
		if detail != "" {
			body["detail"] = detail
		}
		for name, value := range params {
			body[name] = value
		}
	} else if fallbackCode != "" {
		body["code"] = fallbackCode
		body["detail"] = err.Error()
	}
	return body
}

// adminErrorFields maps a known error to its admin API code, upstream detail
// and placeholder fields; code is "" for an error the UI shows verbatim.
func adminErrorFields(err error) (code, detail string, params map[string]interface{}) {
	var flowErr *auth.FlowError
	var refreshErr *tokenRefreshError
	var verifyErr *profileVerifyError
	var mappingErr *config.ModelMappingError
	switch {
	case err == nil:
		return "", "", nil
	case errors.As(err, &refreshErr):
		return codeTokenRefreshFailed, refreshErr.err.Error(), nil
	case errors.As(err, &flowErr):
		params := make(map[string]interface{}, len(flowErr.Params))
		for name, value := range flowErr.Params {
			params[name] = value
		}
		return flowErr.Code, flowErr.Detail, params
	case errors.As(err, &mappingErr):
		return mappingErr.Code, "", mappingErr.Params
	case errors.Is(err, config.ErrInvalidRegion):
		return codeInvalidRegion, "", nil
	case errors.Is(err, config.ErrEmptyKiroAPIKey):
		return codeKiroAPIKeyEmpty, "", nil
	case errors.Is(err, config.ErrInvalidKiroAPIKey), errors.Is(err, config.ErrKiroAPIKeySeparator):
		return codeKiroAPIKeyInvalid, "", nil
	case errors.Is(err, config.ErrInvalidKiroRegion):
		return codeKiroAPIKeyRegion, "", nil
	case errors.Is(err, config.ErrUnsupportedKiroAPIKeyRegion):
		return codeKiroAPIKeyRegionUnsup, "", nil
	case errors.Is(err, config.ErrDuplicateKiroAPIKey):
		return codeKiroAPIKeyDuplicate, "", nil
	case errors.Is(err, config.ErrApiKeyNotFound):
		return codeAPIKeyNotFound, "", nil
	case errors.Is(err, config.ErrApiKeyEmpty):
		return codeAPIKeyEmpty, "", nil
	case errors.Is(err, config.ErrApiKeyExists):
		return codeAPIKeyExists, "", nil
	case errors.Is(err, config.ErrApiKeyCollision):
		return codeAPIKeyCollision, "", nil
	case errors.Is(err, config.ErrTokenLimitNegative):
		return codeTokenLimitNegative, "", nil
	case errors.Is(err, config.ErrCreditLimitNegative):
		return codeCreditLimitNegative, "", nil
	case errors.Is(err, errMicrosoftSSOCanceled):
		return auth.CodeMicrosoftCanceled, "", nil
	case errors.Is(err, errMicrosoftAccountExists):
		return codeMicrosoftDuplicate, "", nil
	case errors.Is(err, errNoKiroProfile):
		return codeNoKiroProfile, "", nil
	case errors.Is(err, errProfileNotOffered):
		return codeProfileNotAvailable, "", nil
	case errors.As(err, &verifyErr):
		return codeProfileVerifyFailed, verifyErr.err.Error(), nil
	}
	return "", "", nil
}

// profileVerifyError is a profile list that could not be loaded to check a
// requested profileArn. A token refresh or empty list inside it keeps its own code.
type profileVerifyError struct{ err error }

func (e *profileVerifyError) Error() string {
	return "Unable to verify profileArn against Kiro profiles: " + e.err.Error()
}

func (e *profileVerifyError) Unwrap() error { return e.err }

// tokenRefreshError is a token refresh that failed before an account call. The
// admin API reports it as token_refresh_failed with the upstream reason as detail.
type tokenRefreshError struct {
	// prefix is the English lead-in the message has always had.
	prefix string
	err    error
}

func (e *tokenRefreshError) Error() string { return e.prefix + ": " + e.err.Error() }

func (e *tokenRefreshError) Unwrap() error { return e.err }

// fail fills a batch or sweep row's error, and its code and detail when known.
func (r *accountResult) fail(err error) {
	r.Error = err.Error()
	if code, detail, _ := adminErrorFields(err); code != "" {
		r.Code = code
		r.Detail = detail
	}
}
