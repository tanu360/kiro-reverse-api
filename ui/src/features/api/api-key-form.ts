import type { ApiKey, ApiKeyCreateRequest, ApiKeyUpdateRequest } from "@/lib/api/types";

/** Every account, or only the picked ones. */
export type ApiKeyAccountScope = "all" | "selected";

/** Raw dialog values. A null limit is an empty field and means 0 (unlimited). */
export interface ApiKeyFormValues {
  name: string;
  key: string;
  tokenLimit: number | null;
  creditLimit: number | null;
  callLimit: number | null;
  accountScope: ApiKeyAccountScope;
  /** The picks. Kept while the scope is "all", so switching back restores them. */
  accountIds: string[];
}

export interface ApiKeyFormData {
  name: string;
  /** Trimmed; "" means generate (create) or keep (edit). */
  key: string;
  tokenLimit: number;
  creditLimit: number;
  callLimit: number;
  /** [] means every account. */
  accountIds: string[];
}

/** The limit field that failed, so only that field is marked invalid. */
export type ApiKeyLimitField = "tokenLimit" | "creditLimit" | "callLimit";

/** Any field the form can mark invalid. */
export type ApiKeyFormField = ApiKeyLimitField | "accountIds";

type ApiKeyFormResult =
  | { ok: true; value: ApiKeyFormData }
  | { ok: false; error: "invalidLimits"; field: ApiKeyLimitField }
  | { ok: false; error: "noAccounts"; field: "accountIds" };

export const EMPTY_API_KEY_FORM: ApiKeyFormValues = {
  name: "",
  key: "",
  tokenLimit: 0,
  creditLimit: 0,
  callLimit: 0,
  accountScope: "all",
  accountIds: [],
};

/** Edit starts from the stored name, limits and accounts. The secret is never prefilled. */
export function formValuesFromKey(apiKey: ApiKey): ApiKeyFormValues {
  const accountIds = apiKey.accountIds ?? [];
  return {
    name: apiKey.name ?? "",
    key: "",
    tokenLimit: apiKey.tokenLimit ?? 0,
    creditLimit: apiKey.creditLimit ?? 0,
    callLimit: apiKey.callLimit ?? 0,
    accountScope: accountIds.length > 0 ? "selected" : "all",
    accountIds: [...accountIds],
  };
}

function isWholeCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/**
 * Old UI rules: empty limits are 0, the token limit is a finite whole number >= 0 (the server
 * decodes it as int64), the credit limit is finite and >= 0. Name and key are trimmed. A failure
 * names the first bad field (token limit before credit limit).
 * The call limit is a whole number >= 0 like the token limit. "Only selected accounts" needs at
 * least one pick: an empty pick would mean every account, the opposite of what was asked.
 */
export function parseApiKeyForm(values: ApiKeyFormValues): ApiKeyFormResult {
  const tokenLimit = values.tokenLimit ?? 0;
  const creditLimit = values.creditLimit ?? 0;
  const callLimit = values.callLimit ?? 0;
  const tokensValid = isWholeCount(tokenLimit);
  const creditsValid = Number.isFinite(creditLimit) && creditLimit >= 0;
  if (!tokensValid) return { ok: false, error: "invalidLimits", field: "tokenLimit" };
  if (!creditsValid) return { ok: false, error: "invalidLimits", field: "creditLimit" };
  if (!isWholeCount(callLimit)) return { ok: false, error: "invalidLimits", field: "callLimit" };
  const selected = values.accountScope === "selected";
  if (selected && values.accountIds.length === 0) {
    return { ok: false, error: "noAccounts", field: "accountIds" };
  }
  return {
    ok: true,
    value: {
      name: values.name.trim(),
      key: values.key.trim(),
      tokenLimit,
      creditLimit,
      callLimit,
      accountIds: selected ? [...new Set(values.accountIds)] : [],
    },
  };
}

/** The key is sent only when a custom value was entered; otherwise the server generates one. */
export function buildCreateRequest(data: ApiKeyFormData): ApiKeyCreateRequest {
  const request: ApiKeyCreateRequest = {
    name: data.name,
    enabled: true,
    tokenLimit: data.tokenLimit,
    creditLimit: data.creditLimit,
    callLimit: data.callLimit,
    accountIds: data.accountIds,
  };
  if (data.key) request.key = data.key;
  return request;
}

/** Edit always sends `key` ("" keeps the current secret) and `accountIds` ([] = every account). */
export function buildUpdateRequest(data: ApiKeyFormData): ApiKeyUpdateRequest {
  return {
    name: data.name,
    key: data.key || "",
    tokenLimit: data.tokenLimit,
    creditLimit: data.creditLimit,
    callLimit: data.callLimit,
    accountIds: data.accountIds,
  };
}

/**
 * Why a key cannot be used now. "disabled": it reached its token or credit limit, so the server
 * disabled it, and reset usage does not enable it again. "calls": it used its successful calls;
 * clients get 429 until the limit is raised or usage is reset, and the key stays enabled.
 */
export function limitReachedReason(apiKey: ApiKey): "disabled" | "calls" | null {
  const tokenLimit = apiKey.tokenLimit ?? 0;
  const creditLimit = apiKey.creditLimit ?? 0;
  const callLimit = apiKey.callLimit ?? 0;
  if (
    (tokenLimit > 0 && apiKey.tokensUsed >= tokenLimit) ||
    (creditLimit > 0 && apiKey.creditsUsed >= creditLimit)
  ) {
    return "disabled";
  }
  if (callLimit > 0 && (apiKey.successfulCalls ?? 0) >= callLimit) return "calls";
  return null;
}

export function isLimitReached(apiKey: ApiKey): boolean {
  return limitReachedReason(apiKey) !== null;
}

export function countEnabledKeys(keys: readonly ApiKey[]): number {
  return keys.filter((k) => k.enabled).length;
}

/** True when removing or disabling `id` leaves no enabled key while API keys are required. */
export function wouldLockOutClients(
  keys: readonly ApiKey[],
  id: string,
  requireApiKey: boolean,
): boolean {
  if (!requireApiKey) return false;
  const target = keys.find((k) => k.id === id);
  return Boolean(target?.enabled) && countEnabledKeys(keys) === 1;
}
