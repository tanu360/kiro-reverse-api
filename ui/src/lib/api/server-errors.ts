import type { TFunction, TParams } from "@/lib/i18n";
import { isApiError } from "./errors";
import type { ServerErrorCode } from "./types";

const BACKUP_UNREADABLE = "errors:serverError.backupUnreadable";

/**
 * ApiErrorBody.code -> translation key. A code wins over the message, so the server can reword
 * its English text without breaking the UI. invalid_cadence and invalid_keep stay unmapped: the
 * schedule form marks the field instead.
 */
export const SERVER_ERROR_CODES: Readonly<Partial<Record<ServerErrorCode, string>>> = {
  api_key_lockout: "errors:serverError.apiKeyLockout",
  invalid_json: "errors:serverError.invalidJSON",
  account_not_found: "errors:serverError.accountNotFound",
  api_key_not_found: "errors:serverError.apiKeyNotFound",
  no_account_ids: "errors:serverError.noAccountIds",
  duplicates_changed: "errors:serverError.duplicatesChanged",
  not_overage_capable: "errors:serverError.notOverageCapable",
  overage_failed: "errors:serverError.overageFailed",
  models_refresh_failed: "errors:serverError.modelsRefreshFailed",
  invalid_region: "errors:serverError.invalidRegion",
  start_url_required: "errors:serverError.startUrlRequired",
  bearer_token_required: "errors:serverError.bearerTokenRequired",
  refresh_token_required: "errors:serverError.refreshTokenRequired",
  kiro_api_key_empty: "errors:serverError.kiroApiKeyEmpty",
  kiro_api_key_invalid: "errors:serverError.kiroApiKeyInvalid",
  kiro_api_key_region: "errors:serverError.kiroApiKeyRegion",
  kiro_api_key_region_unsupported: "errors:serverError.kiroApiKeyRegionUnsupported",
  kiro_api_key_duplicate: "errors:serverError.kiroApiKeyDuplicate",
  token_refresh_failed: "errors:serverError.tokenRefreshFailed",
  profile_arn_invalid: "errors:serverError.profileArnInvalid",
  profile_not_available: "errors:serverError.profileNotAvailable",
  profile_verify_failed: "errors:serverError.profileVerifyFailed",
  no_kiro_profile: "errors:serverError.noKiroProfile",
  api_key_account_no_profile: "errors:serverError.apiKeyAccountNoProfile",
  auto_continue_max_range: "errors:serverError.autoContinueMaxRange",
  routing_mode_invalid: "errors:serverError.routingModeInvalid",
  priority_range: "errors:serverError.priorityRange",
  image_resize_dimension_range: "errors:serverError.imageResizeDimensionRange",
  image_resize_size_range: "errors:serverError.imageResizeSizeRange",
  account_rpm_limit_range: "errors:serverError.accountRpmLimitRange",
  password_too_short: "errors:serverError.passwordTooShort",
  invalid_endpoint: "errors:serverError.invalidEndpoint",
  invalid_api_domain: "errors:serverError.invalidApiDomain",
  proxy_url_scheme: "errors:serverError.proxyUrlScheme",
  proxy_password_masked: "errors:serverError.proxyPasswordMasked",
  api_key_empty: "errors:serverError.apiKeyEmpty",
  api_key_exists: "errors:serverError.apiKeyExists",
  api_key_collision: "errors:serverError.apiKeyCollision",
  token_limit_negative: "errors:serverError.tokenLimitNegative",
  credit_limit_negative: "errors:serverError.creditLimitNegative",
  call_limit_negative: "errors:serverError.callLimitNegative",
  api_key_unknown_account: "errors:serverError.apiKeyUnknownAccount",
  backup_not_found: "errors:serverError.backupNotFound",
  backup_invalid_json: BACKUP_UNREADABLE,
  backup_unsupported_format: BACKUP_UNREADABLE,
  backup_unsupported_version: BACKUP_UNREADABLE,
  backup_schema_mismatch: BACKUP_UNREADABLE,
  backup_upload_failed: "errors:serverError.backupUploadFailed",
  model_mappings_too_many: "errors:serverError.modelMappingsTooMany",
  model_mapping_empty: "errors:serverError.modelMappingEmpty",
  model_mapping_no_source: "errors:serverError.modelMappingNoSource",
  model_mapping_no_target: "errors:serverError.modelMappingNoTarget",
  model_id_too_long: "errors:serverError.modelIdTooLong",
  model_id_invalid_chars: "errors:serverError.modelIdInvalidChars",
  model_mapping_self: "errors:serverError.modelMappingSelf",
  model_mapping_duplicate: "errors:serverError.modelMappingDuplicate",
  model_mapping_chain: "errors:serverError.modelMappingChain",
  sso_register_failed: "errors:serverError.ssoRegisterFailed",
  sso_session_expired: "errors:serverError.ssoSessionExpired",
  sso_timeout: "errors:serverError.ssoTimeout",
  sso_denied: "errors:serverError.ssoDenied",
  sso_check_failed: "errors:serverError.ssoCheckFailed",
  sso_state_mismatch: "errors:serverError.ssoStateMismatch",
  sso_no_code: "errors:serverError.ssoNoCode",
  invalid_callback_url: "errors:serverError.invalidCallbackUrl",
  callback_url_wrong_address: "errors:serverError.callbackUrlWrongAddress",
  kiro_sign_in_failed: "errors:serverError.kiroSignInFailed",
  microsoft_too_many_sessions: "errors:serverError.microsoftTooManySessions",
  microsoft_not_enterprise: "errors:serverError.microsoftNotEnterprise",
  microsoft_canceled: "errors:serverError.microsoftCanceled",
  microsoft_duplicate: "errors:serverError.microsoftDuplicate",
  microsoft_denied: "errors:serverError.microsoftDenied",
  microsoft_token_failed: "errors:serverError.microsoftTokenFailed",
  microsoft_tenant_mismatch: "errors:serverError.microsoftTenantMismatch",
  microsoft_credential_invalid: "errors:serverError.microsoftCredentialInvalid",
  microsoft_profile_unresolved: "errors:serverError.microsoftProfileUnresolved",
  relogin_identity_mismatch: "errors:serverError.reloginIdentityMismatch",
  relogin_pending_not_found: "errors:serverError.reloginPendingNotFound",
  relogin_single_credential: "errors:serverError.reloginSingleCredential",
};

/** The `code` of an ApiError's JSON body, or null. */
export function serverErrorCode(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" && code ? code : null;
}

/**
 * The text for a server code, or null for an unmapped one. The string and number `fields` of
 * the body (or batch row) fill the text's placeholders; a non-empty `detail`, upstream text the
 * server passes through, follows as "(Details: …)".
 */
export function serverCodeMessage(
  code: string | null | undefined,
  fields: object,
  t: TFunction,
): string | null {
  const key = code ? SERVER_ERROR_CODES[code as ServerErrorCode] : undefined;
  if (!key) return null;
  const params: TParams = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string" || typeof value === "number") params[name] = value;
  }
  const text = t(key, params);
  const raw: unknown = (fields as { detail?: unknown }).detail;
  const detail = typeof raw === "string" ? raw.trim() : "";
  return detail
    ? t("common:text.joinSentences", {
        first: text,
        second: t("errors:serverError.detail", { detail }),
      })
    : text;
}

/**
 * Exact server error message -> 'errors:<key>', for a body without a code: the sign-in 401 and
 * 429, and a server older than the codes. Pairs rather than an object, so every message stays a
 * quoted string as the server sends it.
 */
export const SERVER_ERROR_KEYS: readonly (readonly [message: string, key: string])[] = [
  ["Invalid JSON", "errors:serverError.invalidJSON"],
  ["Unauthorized", "errors:serverError.unauthorized"],
  ["Not Found", "errors:serverError.notFound"],
  ["Account not found", "errors:serverError.accountNotFound"],
  ["API key not found", "errors:serverError.apiKeyNotFound"],
  ["No account IDs provided", "errors:serverError.noAccountIds"],
  ["startUrl is required", "errors:serverError.startUrlRequired"],
  ["bearerToken is required", "errors:serverError.bearerTokenRequired"],
  ["refreshToken is required", "errors:serverError.refreshTokenRequired"],
  ["refreshToken or kiroApiKey is required", "errors:serverError.refreshTokenRequired"],
  ["kiroApiKey is empty", "errors:serverError.kiroApiKeyEmpty"],
  ["kiroApiKey contains invalid characters", "errors:serverError.kiroApiKeyInvalid"],
  ["kiroApiKey has more than one '|' separator", "errors:serverError.kiroApiKeyInvalid"],
  ["invalid Kiro API key region", "errors:serverError.kiroApiKeyRegion"],
  ["this Kiro API key is already added", "errors:serverError.kiroApiKeyDuplicate"],
  [
    "unsupported Kiro API key region: use us-east-1 or eu-central-1",
    "errors:serverError.kiroApiKeyRegionUnsupported",
  ],
  ["invalid region", "errors:serverError.invalidRegion"],
  [
    "Too many admin password attempts; try again later",
    "errors:serverError.tooManyPasswordAttempts",
  ],
  ["Password must be at least 8 characters", "errors:serverError.passwordTooShort"],
  ["autoContinueMax must be between 1 and 10", "errors:serverError.autoContinueMaxRange"],
  ["Account is not overage capable", "errors:serverError.notOverageCapable"],
  [
    "API key accounts have no Kiro profile; their region is set at import",
    "errors:serverError.apiKeyAccountNoProfile",
  ],
  [
    "Selected Kiro profile is not available for this account",
    "errors:serverError.profileNotAvailable",
  ],
  ["profileArn is invalid", "errors:serverError.profileArnInvalid"],
  [
    "proxyURL must start with http://, https://, socks5://, or socks5h://",
    "errors:serverError.proxyUrlScheme",
  ],
  [
    "Invalid endpoint, must be: auto, kiro, codewhisperer, or amazonq",
    "errors:serverError.invalidEndpoint",
  ],
  ["Invalid apiDomain, must be: amazonaws or kiro", "errors:serverError.invalidApiDomain"],
  ["apiRegion must be us-east-1 or eu-central-1", "errors:serverError.invalidRegion"],
  ["Invalid authRegion", "errors:serverError.invalidRegion"],
  ["api key already exists", "errors:serverError.apiKeyExists"],
  ["api key value collides with existing entry", "errors:serverError.apiKeyCollision"],
  ["token limit must be zero or positive", "errors:serverError.tokenLimitNegative"],
  ["credit limit must be zero or positive", "errors:serverError.creditLimitNegative"],
  ["this Microsoft SSO login was canceled", "errors:serverError.microsoftCanceled"],
  ["this Microsoft account is already added", "errors:serverError.microsoftDuplicate"],
];

const lookup = new Map(SERVER_ERROR_KEYS.map(([message, key]) => [message.toLowerCase(), key]));

/** Trimmed, case-insensitive lookup in SERVER_ERROR_KEYS. */
export function serverErrorKey(message: string): string | null {
  const normalized = String(message ?? "").trim();
  return lookup.get(normalized.toLowerCase()) ?? null;
}

/**
 * Chinese messages from the AWS sign-in code (auth/sso_token.go; auth/iam_sso.go also sends a
 * code now) -> key. The SSO token import sends them without a code, one per token in `errors`
 * or "; "-joined in `error`. They can be wrapped ("token 1: token 验证失败: 401 Unauthorized"), so each is found inside
 * the message. The text after "<phrase>:" is passed as {detail}. Longest phrase first, so
 * "批准授权失败" wins over "授权失败".
 */
export const SERVER_ERROR_PHRASES: readonly (readonly [phrase: string, key: string])[] = [
  ["会话不存在或已过期", "errors:serverError.ssoSessionExpired"],
  ["会话已过期", "errors:serverError.ssoSessionExpired"],
  ["无效的回调 URL", "errors:serverError.invalidCallbackUrl"],
  ["状态不匹配，可能存在安全风险", "errors:serverError.ssoStateMismatch"],
  ["未收到授权码", "errors:serverError.ssoNoCode"],
  ["授权超时", "errors:serverError.ssoTimeout"],
  ["授权失败", "errors:serverError.ssoDenied"],
  ["授权错误", "errors:serverError.ssoDenied"],
  ["注册客户端失败", "errors:serverError.ssoRegisterFailed"],
  ["设备授权失败", "errors:serverError.ssoRegisterFailed"],
  ["token 验证失败", "errors:serverError.ssoTokenRejected"],
  ["获取设备会话失败", "errors:serverError.ssoTokenFlowFailed"],
  ["接受用户代码失败", "errors:serverError.ssoTokenFlowFailed"],
  ["批准授权失败", "errors:serverError.ssoTokenFlowFailed"],
  ["获取 Token 失败", "errors:serverError.ssoTokenFlowFailed"],
];

const phrases = [...SERVER_ERROR_PHRASES].sort(([a], [b]) => b.length - a.length);

/** Key and {detail} for a message that contains one of SERVER_ERROR_PHRASES, else null. */
export function serverErrorPhrase(message: string): { key: string; detail: string } | null {
  const text = String(message ?? "").trim();
  for (const [phrase, key] of phrases) {
    const index = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (index === -1) continue;
    const detail = text
      .slice(index + phrase.length)
      .replace(/^\s*[:：]\s*/, "")
      .trim();
    return { key, detail };
  }
  return null;
}

/**
 * A server message that came without a code (an SSO token import's per-token `errors`) in the
 * UI language when it is a known one, else verbatim.
 */
export function serverMessageText(message: string, t: TFunction): string {
  return translateServerMessage(message, t) ?? message;
}

/** One server message (or one "; "-joined part of it) in the UI language, or null. */
function translateServerMessage(message: string, t: TFunction): string | null {
  const key = serverErrorKey(message);
  if (key) return t(key);
  const phrase = serverErrorPhrase(message);
  if (!phrase) return null;
  const text = t(phrase.key);
  return phrase.detail
    ? t("common:text.joinSentences", {
        first: text,
        second: t("errors:serverError.detail", { detail: phrase.detail }),
      })
    : text;
}

/**
 * User-facing message for any thrown value: the network message for status 0, the translation
 * of a known code or server message, an unknown server message verbatim, else the fallback.
 */
export function errorMessage(error: unknown, t: TFunction, fallbackKey = "errors:generic"): string {
  if (!isApiError(error)) return t(fallbackKey);
  if (error.status === 0) return t("errors:network");
  const body = typeof error.body === "object" && error.body !== null ? error.body : {};
  const coded = serverCodeMessage(serverErrorCode(error), body, t);
  if (coded) return coded;
  const message = error.serverMessage.trim();
  if (!message) return t(fallbackKey);
  const exact = serverErrorKey(message);
  if (exact) return t(exact);
  // SSO token import joins one error per token with "; ".
  const parts = message.split("; ");
  const translated = parts.map((part) => translateServerMessage(part, t));
  if (translated.some((part) => part !== null)) {
    return translated.map((part, index) => part ?? parts[index]).join(" ");
  }
  return message;
}
