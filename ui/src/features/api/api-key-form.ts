import type {
  ApiKey,
  ApiKeyCreateRequest,
  ApiKeyRoutingMode,
  ApiKeyUpdateRequest,
} from "@/lib/api/types";

/** The server's bounds (config/apikey_controls.go). */
export const MAX_KEY_RPM = 10_000;
export const MAX_KEY_MODELS = 50;
export const MAX_KEY_MODEL_LENGTH = 128;
export const MAX_KEY_TAGS = 10;

export const KEY_ROUTING_MODES: readonly ApiKeyRoutingMode[] = [
  "inherit",
  "weighted",
  "priority",
  "reset_first",
];

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
  /** Picked account tags; like `accountIds`, kept while the scope is "all". */
  accountTags: string[];
  /** Comma-separated model names; "" = every model. */
  allowedModels: string;
  rpmLimit: number | null;
  /** A datetime-local value in the viewer's time zone; "" = never. */
  expiresAt: string;
  routingMode: ApiKeyRoutingMode;
}

export interface ApiKeyFormData {
  name: string;
  /** Trimmed; "" means generate (create) or keep (edit). */
  key: string;
  tokenLimit: number;
  creditLimit: number;
  callLimit: number;
  /** [] means every account (with no tags). */
  accountIds: string[];
  /** [] means no account is picked by tag. */
  accountTags: string[];
  /** [] means every model. */
  allowedModels: string[];
  rpmLimit: number;
  /** unix s; 0 = never. */
  expiresAt: number;
  routingMode: ApiKeyRoutingMode;
}

/** The limit field that failed, so only that field is marked invalid. */
export type ApiKeyLimitField = "tokenLimit" | "creditLimit" | "callLimit" | "rpmLimit";

/** Any field the form can mark invalid. */
export type ApiKeyFormField = ApiKeyLimitField | "accountIds" | "allowedModels" | "expiresAt";

type ApiKeyFormResult =
  | { ok: true; value: ApiKeyFormData }
  | { ok: false; error: "invalidLimits"; field: ApiKeyLimitField }
  | { ok: false; error: "noAccounts"; field: "accountIds" }
  | { ok: false; error: "tooManyModels" | "modelTooLong"; field: "allowedModels" }
  | { ok: false; error: "invalidExpiry"; field: "expiresAt" };

export const EMPTY_API_KEY_FORM: ApiKeyFormValues = {
  name: "",
  key: "",
  tokenLimit: 0,
  creditLimit: 0,
  callLimit: 0,
  accountScope: "all",
  accountIds: [],
  accountTags: [],
  allowedModels: "",
  rpmLimit: 0,
  expiresAt: "",
  routingMode: "inherit",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** unix s -> a datetime-local value in the viewer's time zone ("" for 0). */
export function toLocalDateTimeInput(unixSec: number | undefined): string {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (viewer's time zone) -> unix s; 0 for "", null when unparsable. */
export function fromLocalDateTimeInput(value: string): number | null {
  const text = value.trim();
  if (!text) return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Model names typed comma- or newline-separated: trimmed, blanks and case-insensitive repeats dropped. */
export function parseModelList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,，、\n]/)) {
    const model = raw.trim();
    if (!model || seen.has(model.toLowerCase())) continue;
    seen.add(model.toLowerCase());
    out.push(model);
  }
  return out;
}

/** Edit starts from the stored name, limits and accounts. The secret is never prefilled. */
export function formValuesFromKey(apiKey: ApiKey): ApiKeyFormValues {
  const accountIds = apiKey.accountIds ?? [];
  const accountTags = apiKey.accountTags ?? [];
  return {
    name: apiKey.name ?? "",
    key: "",
    tokenLimit: apiKey.tokenLimit ?? 0,
    creditLimit: apiKey.creditLimit ?? 0,
    callLimit: apiKey.callLimit ?? 0,
    accountScope: accountIds.length > 0 || accountTags.length > 0 ? "selected" : "all",
    accountIds: [...accountIds],
    accountTags: [...accountTags],
    allowedModels: (apiKey.allowedModels ?? []).join(", "),
    rpmLimit: apiKey.rpmLimit ?? 0,
    expiresAt: toLocalDateTimeInput(apiKey.expiresAt),
    routingMode: apiKey.routingMode ?? "inherit",
  };
}

function isWholeCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/**
 * Old UI rules: empty limits are 0, the token limit is a finite whole number >= 0 (the server
 * decodes it as int64), the credit limit is finite and >= 0. Name and key are trimmed. A failure
 * names the first bad field (token limit before credit limit).
 * The call limit is a whole number >= 0 like the token limit, and so is the RPM limit, up to
 * MAX_KEY_RPM. "Only selected accounts" needs at least one account or tag: an empty pick would
 * mean every account, the opposite of what was asked. The model list holds at most
 * MAX_KEY_MODELS names of up to MAX_KEY_MODEL_LENGTH characters. An expiry must parse; one in
 * the past is allowed (it switches the key off at once).
 */
export function parseApiKeyForm(values: ApiKeyFormValues): ApiKeyFormResult {
  const tokenLimit = values.tokenLimit ?? 0;
  const creditLimit = values.creditLimit ?? 0;
  const callLimit = values.callLimit ?? 0;
  const rpmLimit = values.rpmLimit ?? 0;
  const tokensValid = isWholeCount(tokenLimit);
  const creditsValid = Number.isFinite(creditLimit) && creditLimit >= 0;
  if (!tokensValid) return { ok: false, error: "invalidLimits", field: "tokenLimit" };
  if (!creditsValid) return { ok: false, error: "invalidLimits", field: "creditLimit" };
  if (!isWholeCount(callLimit)) return { ok: false, error: "invalidLimits", field: "callLimit" };
  if (!isWholeCount(rpmLimit) || rpmLimit > MAX_KEY_RPM) {
    return { ok: false, error: "invalidLimits", field: "rpmLimit" };
  }
  const selected = values.accountScope === "selected";
  if (selected && values.accountIds.length === 0 && values.accountTags.length === 0) {
    return { ok: false, error: "noAccounts", field: "accountIds" };
  }
  const models = parseModelList(values.allowedModels);
  if (models.length > MAX_KEY_MODELS) {
    return { ok: false, error: "tooManyModels", field: "allowedModels" };
  }
  if (models.some((model) => model.length > MAX_KEY_MODEL_LENGTH)) {
    return { ok: false, error: "modelTooLong", field: "allowedModels" };
  }
  const expiresAt = fromLocalDateTimeInput(values.expiresAt);
  if (expiresAt === null) return { ok: false, error: "invalidExpiry", field: "expiresAt" };
  return {
    ok: true,
    value: {
      name: values.name.trim(),
      key: values.key.trim(),
      tokenLimit,
      creditLimit,
      callLimit,
      accountIds: selected ? [...new Set(values.accountIds)] : [],
      accountTags: selected ? [...new Set(values.accountTags)] : [],
      allowedModels: models,
      rpmLimit,
      expiresAt,
      routingMode: values.routingMode,
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
    accountTags: data.accountTags,
    allowedModels: data.allowedModels,
    rpmLimit: data.rpmLimit,
    expiresAt: data.expiresAt,
    routingMode: data.routingMode,
  };
  if (data.key) request.key = data.key;
  return request;
}

/**
 * Edit always sends `key` ("" keeps the current secret), `accountIds` and `accountTags` (both []
 * = every account), `allowedModels` ([] = every model), `expiresAt` (0 = never) and the mode.
 */
export function buildUpdateRequest(data: ApiKeyFormData): ApiKeyUpdateRequest {
  return {
    name: data.name,
    key: data.key || "",
    tokenLimit: data.tokenLimit,
    creditLimit: data.creditLimit,
    callLimit: data.callLimit,
    accountIds: data.accountIds,
    accountTags: data.accountTags,
    allowedModels: data.allowedModels,
    rpmLimit: data.rpmLimit,
    expiresAt: data.expiresAt,
    routingMode: data.routingMode,
  };
}

/** Whether the key's expiry has come: the server's flag, or the time when it is stale. */
export function isKeyExpired(apiKey: ApiKey, nowSec: number = Date.now() / 1000): boolean {
  return (
    Boolean(apiKey.expired) || (Boolean(apiKey.expiresAt) && (apiKey.expiresAt ?? 0) <= nowSec)
  );
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
