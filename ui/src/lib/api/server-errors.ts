import type { TFunction } from "@/lib/i18n";
import { isApiError } from "./errors";
import type { ServerErrorCode } from "./types";

/**
 * ApiErrorBody.code -> translation key. A code wins over the message, so the server can reword
 * its English text without breaking the UI.
 */
export const SERVER_ERROR_CODES: Readonly<Partial<Record<ServerErrorCode, string>>> = {
  api_key_lockout: "errors:serverError.apiKeyLockout",
};

/** The `code` of an ApiError's JSON body, or null. */
export function serverErrorCode(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" && code ? code : null;
}

/** Exact server error message -> 'errors:<key>'. The server sends English text with no codes. */
// biome-ignore format: keys are the exact server strings; keep them single-quoted, one per line.
export const SERVER_ERROR_KEYS: Readonly<Record<string, string>> = {
  'Invalid JSON': "errors:serverError.invalidJSON",
  'Unauthorized': "errors:serverError.unauthorized",
  'Not Found': "errors:serverError.notFound",
  'Account not found': "errors:serverError.accountNotFound",
  'API key not found': "errors:serverError.apiKeyNotFound",
  'No account IDs provided': "errors:serverError.noAccountIds",
  'startUrl is required': "errors:serverError.startUrlRequired",
  'bearerToken is required': "errors:serverError.bearerTokenRequired",
  'refreshToken is required': "errors:serverError.refreshTokenRequired",
  'refreshToken or kiroApiKey is required': "errors:serverError.refreshTokenRequired",
  'kiroApiKey is empty': "errors:serverError.kiroApiKeyEmpty",
  'kiroApiKey contains invalid characters': "errors:serverError.kiroApiKeyInvalid",
  "kiroApiKey has more than one '|' separator": "errors:serverError.kiroApiKeyInvalid",
  'invalid Kiro API key region': "errors:serverError.kiroApiKeyRegion",
  'this Kiro API key is already added': "errors:serverError.kiroApiKeyDuplicate",
  'unsupported Kiro API key region: use us-east-1 or eu-central-1': "errors:serverError.kiroApiKeyRegionUnsupported",
  'invalid region': "errors:serverError.invalidRegion",
  'Too many admin password attempts; try again later': "errors:serverError.tooManyPasswordAttempts",
  'Password must be at least 8 characters': "errors:serverError.passwordTooShort",
  'autoContinueMax must be between 1 and 10': "errors:serverError.autoContinueMaxRange",
  'Account is not overage capable': "errors:serverError.notOverageCapable",
  'API key accounts have no Kiro profile; their region is set at import': "errors:serverError.apiKeyAccountNoProfile",
  'Selected Kiro profile is not available for this account': "errors:serverError.profileNotAvailable",
  'profileArn is invalid': "errors:serverError.profileArnInvalid",
  'proxyURL must start with http://, https://, socks5://, or socks5h://': "errors:serverError.proxyUrlScheme",
  'Invalid endpoint, must be: auto, kiro, codewhisperer, or amazonq': "errors:serverError.invalidEndpoint",
  'api key already exists': "errors:serverError.apiKeyExists",
  'api key value collides with existing entry': "errors:serverError.apiKeyCollision",
  'token limit must be zero or positive': "errors:serverError.tokenLimitNegative",
  'credit limit must be zero or positive': "errors:serverError.creditLimitNegative",
  'Microsoft SSO login was canceled': "errors:serverError.microsoftCanceled",
  'this Microsoft account is already added': "errors:serverError.microsoftDuplicate",
};

const lookup = new Map(
  Object.entries(SERVER_ERROR_KEYS).map(([message, key]) => [message.toLowerCase(), key]),
);

/** Trimmed, case-insensitive lookup in SERVER_ERROR_KEYS. */
export function serverErrorKey(message: string): string | null {
  const normalized = String(message ?? "").trim();
  return lookup.get(normalized.toLowerCase()) ?? null;
}

/**
 * Chinese messages from the AWS sign-in code (auth/iam_sso.go, auth/sso_token.go) -> key.
 * They can be wrapped ("token 1: token 验证失败: 401 Unauthorized"), so each is found inside
 * the message. The text after "<phrase>:" is passed as {detail}. Longest phrase first, so
 * "批准授权失败" wins over "授权失败".
 */
// biome-ignore format: keys are the exact server phrases; keep them one per line.
export const SERVER_ERROR_PHRASES: Readonly<Record<string, string>> = {
  '会话不存在或已过期': "errors:serverError.ssoSessionExpired",
  '会话已过期': "errors:serverError.ssoSessionExpired",
  '无效的回调 URL': "errors:serverError.invalidCallbackUrl",
  '状态不匹配，可能存在安全风险': "errors:serverError.ssoStateMismatch",
  '未收到授权码': "errors:serverError.ssoNoCode",
  '授权超时': "errors:serverError.ssoTimeout",
  '授权失败': "errors:serverError.ssoDenied",
  '授权错误': "errors:serverError.ssoDenied",
  '注册客户端失败': "errors:serverError.ssoRegisterFailed",
  '设备授权失败': "errors:serverError.ssoRegisterFailed",
  'token 验证失败': "errors:serverError.ssoTokenRejected",
  '获取设备会话失败': "errors:serverError.ssoTokenFlowFailed",
  '接受用户代码失败': "errors:serverError.ssoTokenFlowFailed",
  '批准授权失败': "errors:serverError.ssoTokenFlowFailed",
  '获取 Token 失败': "errors:serverError.ssoTokenFlowFailed",
};

const phrases = Object.entries(SERVER_ERROR_PHRASES).sort(([a], [b]) => b.length - a.length);

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
 * of a known server message, an unknown server message verbatim, else the fallback.
 */
export function errorMessage(error: unknown, t: TFunction, fallbackKey = "errors:generic"): string {
  if (!isApiError(error)) return t(fallbackKey);
  if (error.status === 0) return t("errors:network");
  const code = serverErrorCode(error);
  const codeKey = code ? SERVER_ERROR_CODES[code as ServerErrorCode] : undefined;
  if (codeKey) return t(codeKey);
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
