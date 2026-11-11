package auth

// FlowError is a sign-in failure the admin UI translates by Code (see
// ui/src/lib/api/server-errors.ts). Error() is the English text the API has
// always sent. Detail, when set, is the upstream part of that text, which the
// UI shows as-is after its translation; Params fill the translation's
// placeholders.
type FlowError struct {
	Code   string
	Text   string
	Detail string
	Params map[string]string
	Err    error
}

func (e *FlowError) Error() string { return e.Text }

func (e *FlowError) Unwrap() error { return e.Err }

func flowError(code, text string) *FlowError {
	return &FlowError{Code: code, Text: text}
}

// flowErrorDetail keeps "<text>: <detail>" as the English message.
func flowErrorDetail(code, text, detail string) *FlowError {
	return &FlowError{Code: code, Text: text + ": " + detail, Detail: detail}
}

// wrapFlowError is flowErrorDetail for an upstream error, which it keeps for errors.Is.
func wrapFlowError(code, text string, err error) *FlowError {
	return &FlowError{Code: code, Text: text + ": " + err.Error(), Detail: err.Error(), Err: err}
}

// Codes of the sign-in failures the admin UI translates.
const (
	CodeSSORegisterFailed        = "sso_register_failed"
	CodeSSOSessionExpired        = "sso_session_expired"
	CodeSSOTimeout               = "sso_timeout"
	CodeSSODenied                = "sso_denied"
	CodeSSOCheckFailed           = "sso_check_failed"
	CodeSSOStateMismatch         = "sso_state_mismatch"
	CodeSSONoCode                = "sso_no_code"
	CodeInvalidCallbackURL       = "invalid_callback_url"
	CodeCallbackURLWrongAddress  = "callback_url_wrong_address"
	CodeKiroSignInFailed         = "kiro_sign_in_failed"
	CodeMicrosoftTooManySessions = "microsoft_too_many_sessions"
	CodeMicrosoftNotEnterprise   = "microsoft_not_enterprise"
	CodeMicrosoftCanceled        = "microsoft_canceled"
	CodeMicrosoftDenied          = "microsoft_denied"
	CodeMicrosoftTokenFailed     = "microsoft_token_failed"
	CodeMicrosoftTenantMismatch  = "microsoft_tenant_mismatch"
)
