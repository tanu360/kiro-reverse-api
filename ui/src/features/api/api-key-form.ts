import type { ApiKey, ApiKeyCreateRequest, ApiKeyUpdateRequest } from "@/lib/api/types";

/** Raw dialog values. A null limit is an empty field and means 0 (unlimited). */
export interface ApiKeyFormValues {
  name: string;
  key: string;
  tokenLimit: number | null;
  creditLimit: number | null;
}

export interface ApiKeyFormData {
  name: string;
  /** Trimmed; "" means generate (create) or keep (edit). */
  key: string;
  tokenLimit: number;
  creditLimit: number;
}

/** The limit field that failed, so only that field is marked invalid. */
export type ApiKeyLimitField = "tokenLimit" | "creditLimit";

type ApiKeyFormResult =
  | { ok: true; value: ApiKeyFormData }
  | { ok: false; error: "invalidLimits"; field: ApiKeyLimitField };

export const EMPTY_API_KEY_FORM: ApiKeyFormValues = {
  name: "",
  key: "",
  tokenLimit: 0,
  creditLimit: 0,
};

/** Edit starts from the stored name and limits. The secret is never prefilled. */
export function formValuesFromKey(apiKey: ApiKey): ApiKeyFormValues {
  return {
    name: apiKey.name ?? "",
    key: "",
    tokenLimit: apiKey.tokenLimit ?? 0,
    creditLimit: apiKey.creditLimit ?? 0,
  };
}

/**
 * Old UI rules: empty limits are 0, the token limit is a finite whole number >= 0 (the server
 * decodes it as int64), the credit limit is finite and >= 0. Name and key are trimmed. A failure
 * names the first bad field (token limit before credit limit).
 */
export function parseApiKeyForm(values: ApiKeyFormValues): ApiKeyFormResult {
  const tokenLimit = values.tokenLimit ?? 0;
  const creditLimit = values.creditLimit ?? 0;
  const tokensValid =
    Number.isFinite(tokenLimit) && tokenLimit >= 0 && Number.isInteger(tokenLimit);
  const creditsValid = Number.isFinite(creditLimit) && creditLimit >= 0;
  if (!tokensValid) return { ok: false, error: "invalidLimits", field: "tokenLimit" };
  if (!creditsValid) return { ok: false, error: "invalidLimits", field: "creditLimit" };
  return {
    ok: true,
    value: { name: values.name.trim(), key: values.key.trim(), tokenLimit, creditLimit },
  };
}

/** The key is sent only when a custom value was entered; otherwise the server generates one. */
export function buildCreateRequest(data: ApiKeyFormData): ApiKeyCreateRequest {
  const request: ApiKeyCreateRequest = {
    name: data.name,
    enabled: true,
    tokenLimit: data.tokenLimit,
    creditLimit: data.creditLimit,
  };
  if (data.key) request.key = data.key;
  return request;
}

/** Edit always sends `key`; "" keeps the current secret. */
export function buildUpdateRequest(data: ApiKeyFormData): ApiKeyUpdateRequest {
  return {
    name: data.name,
    key: data.key || "",
    tokenLimit: data.tokenLimit,
    creditLimit: data.creditLimit,
  };
}

/** The server disables a key once it reaches a limit; reset usage does not enable it again. */
export function isLimitReached(apiKey: ApiKey): boolean {
  const tokenLimit = apiKey.tokenLimit ?? 0;
  const creditLimit = apiKey.creditLimit ?? 0;
  return (
    (tokenLimit > 0 && apiKey.tokensUsed >= tokenLimit) ||
    (creditLimit > 0 && apiKey.creditsUsed >= creditLimit)
  );
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
