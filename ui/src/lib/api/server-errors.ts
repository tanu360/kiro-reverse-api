import type { TFunction } from "@/lib/i18n";
import { isApiError } from "./errors";

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
 * User-facing message for any thrown value: the network message for status 0, the translation
 * of a known server message, an unknown server message verbatim, else the fallback.
 */
export function errorMessage(error: unknown, t: TFunction, fallbackKey = "errors:generic"): string {
  if (!isApiError(error)) return t(fallbackKey);
  if (error.status === 0) return t("errors:network");
  const key = serverErrorKey(error.serverMessage);
  if (key) return t(key);
  const message = error.serverMessage.trim();
  return message || t(fallbackKey);
}
