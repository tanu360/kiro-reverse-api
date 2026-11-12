import { type HttpHandler, HttpResponse, http } from "msw";
import type { CountTokensAuthType, CountTokensConfig } from "@/lib/api/count-tokens";
import type { ResponseHeaderRule } from "@/lib/api/response-headers";
import type {
  ApiDomain,
  ModelMappingRule,
  PreferredEndpoint,
  PromptFilterRule,
  RoutingMode,
  SettingsPatch,
  ThinkingFormat,
} from "@/lib/api/types";
import { claimMockPassword, mockDb, mockNowUnix } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import { defaultModelMappings } from "@/lib/mocks/fixtures";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";
import { maskCountTokensKey, sameCountTokensOrigin, validCountTokensUrl } from "./lib/count-tokens";
import {
  listProblem,
  MAX_RESPONSE_HEADERS,
  normalizeHeaders,
  RESPONSE_HEADER_VARIABLES,
} from "./lib/response-headers";

// Mirrors the Go admin API (proxy/handler.go, config/model_mapping_validation.go): the same
// validation order, error strings and patch semantics.

const OK = { success: true } as const;

/** A saved settings write: other tabs refetch on settings_changed, as Go sends it. */
function saved(): Response {
  publishMockEvent("settings_changed");
  return HttpResponse.json(OK);
}
const MAX_AUTO_CONTINUE = 10;
const MAX_LOG_RETENTION_DAYS = 3650;
const IMAGE_RESIZE_DIMENSION = { min: 256, max: 4096 };
const IMAGE_RESIZE_KB = { min: 50, max: 4096 };
const MIN_PASSWORD_RUNES = 8;
const MAX_MAPPINGS = 200;
const MAX_MODEL_ID_BYTES = 256;
const THINKING_FORMATS: readonly ThinkingFormat[] = ["reasoning_content", "thinking", "think"];
const ENDPOINTS: readonly PreferredEndpoint[] = ["auto", "kiro", "codewhisperer", "amazonq"];
const PROXY_SCHEMES = ["http://", "https://", "socks5://", "socks5h://"];
const COUNT_TOKENS_AUTH_TYPES: readonly CountTokensAuthType[] = ["x-api-key", "bearer"];
const MAX_COUNT_TOKENS_KEY = 4096;

function countTokensConfig(): CountTokensConfig {
  const { url, authType, key } = mockDb.countTokens;
  return {
    countTokensApiUrl: url,
    countTokensAuthType: authType,
    countTokensApiKeySet: key !== "",
    countTokensApiKeyMasked: maskCountTokensKey(key),
  };
}

const API_DOMAINS: readonly ApiDomain[] = ["amazonaws", "kiro"];
/** config.KiroServiceRegions */
const API_REGIONS = ["us-east-1", "eu-central-1"];
/** config.NormalizeAWSRegion */
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/;

const ROUTING_MODES: readonly string[] = ["weighted", "priority"] satisfies RoutingMode[];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object body, or null when Go's decoder would answer 400 Invalid JSON. */
async function readObject(request: Request): Promise<Json | null> {
  const body: unknown = await request.json().catch(() => undefined);
  return isRecord(body) ? body : null;
}

function invalidJson(): Response {
  return jsonError(400, "Invalid JSON");
}

/** Optional typed field: undefined when absent, null when the type would fail Go's decoder. */
function optional<T>(
  body: Json,
  key: string,
  check: (value: unknown) => value is T,
): T | undefined | null {
  if (!(key in body) || body[key] === null) return undefined;
  return check(body[key]) ? (body[key] as T) : null;
}

const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isString = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number => Number.isInteger(value);

function readSettingsPatch(body: Json): SettingsPatch | null {
  const patch: SettingsPatch = {};
  const boolKeys = [
    "requireApiKey",
    "allowOverUsage",
    "lenientStreamIntegrity",
    "sessionAffinity",
    "autoContinue",
    "structuredToolHistory",
    "imageResize",
  ] as const;
  for (const key of boolKeys) {
    const value = optional(body, key, isBool);
    if (value === null) return null;
    if (value !== undefined) patch[key] = value;
  }
  const max = optional(body, "autoContinueMax", isInteger);
  if (max === null) return null;
  if (max !== undefined) patch.autoContinueMax = max;
  const refresh = optional(body, "usageRefreshIntervalMinutes", isInteger);
  if (refresh === null) return null;
  if (refresh !== undefined) patch.usageRefreshIntervalMinutes = refresh;
  // Any string decodes; the handler then rejects an unknown mode with routing_mode_invalid.
  const routingMode = optional(body, "routingMode", isString);
  if (routingMode === null) return null;
  if (routingMode !== undefined) patch.routingMode = routingMode as RoutingMode;
  const maxDimension = optional(body, "imageResizeMaxDimension", isInteger);
  if (maxDimension === null) return null;
  if (maxDimension !== undefined) patch.imageResizeMaxDimension = maxDimension;
  const maxKB = optional(body, "imageResizeMaxKB", isInteger);
  if (maxKB === null) return null;
  if (maxKB !== undefined) patch.imageResizeMaxKB = maxKB;
  const password = optional(body, "password", isString);
  if (password === null) return null;
  if (password !== undefined) patch.password = password;
  return patch;
}

/** Go's validateImageResizePatch (proxy/admin_image_resize.go): dimension first, then size. */
function imageResizeRangeError(patch: SettingsPatch): Response | null {
  const dim = patch.imageResizeMaxDimension;
  if (dim !== undefined && (dim < IMAGE_RESIZE_DIMENSION.min || dim > IMAGE_RESIZE_DIMENSION.max)) {
    return jsonError(
      400,
      `imageResizeMaxDimension must be between ${IMAGE_RESIZE_DIMENSION.min} and ${IMAGE_RESIZE_DIMENSION.max}`,
      { code: "image_resize_dimension_range" },
    );
  }
  const kb = patch.imageResizeMaxKB;
  if (kb !== undefined && (kb < IMAGE_RESIZE_KB.min || kb > IMAGE_RESIZE_KB.max)) {
    return jsonError(
      400,
      `imageResizeMaxKB must be between ${IMAGE_RESIZE_KB.min} and ${IMAGE_RESIZE_KB.max}`,
      { code: "image_resize_size_range" },
    );
  }
  return null;
}

function validateModelId(id: string): { error: string; code: string } | null {
  if (new TextEncoder().encode(id).length > MAX_MODEL_ID_BYTES) {
    return {
      error: `model ID ${JSON.stringify(id.slice(0, 32))}... is longer than ${MAX_MODEL_ID_BYTES} bytes`,
      code: "model_id_too_long",
    };
  }
  // Go: unicode.IsSpace || unicode.IsControl
  if (/[\s\p{Cc}]/u.test(id)) {
    return {
      error: `model ID ${JSON.stringify(id)} contains whitespace or control characters`,
      code: "model_id_invalid_chars",
    };
  }
  return null;
}

/** The error body fields besides `error`: the code and its placeholders (config.ModelMappingError). */
type MappingFields = { index: number; code: string; model?: string; max?: number };

type MappingResult =
  | { ok: true; rules: ModelMappingRule[] }
  | ({ ok: false; error: string } & MappingFields);

/** config.normalizeModelMappings: keys trimmed and lowercased, values trimmed. */
function normalizeMappings(input: ModelMappingRule[]): MappingResult {
  if (input.length > MAX_MAPPINGS) {
    return {
      ok: false,
      index: -1,
      code: "model_mappings_too_many",
      max: MAX_MAPPINGS,
      error: `at most ${MAX_MAPPINGS} model mappings are allowed`,
    };
  }
  const cleaned: ModelMappingRule[] = [];
  for (const [i, mapping] of input.entries()) {
    const key = mapping.key.trim().toLowerCase();
    const value = mapping.value.trim();
    if (!key && !value) {
      return {
        ok: false,
        index: i,
        code: "model_mapping_empty",
        error: `model mapping ${i + 1} is empty`,
      };
    }
    if (!key) {
      return {
        ok: false,
        index: i,
        code: "model_mapping_no_source",
        error: `mapping to ${JSON.stringify(value)} has no source model`,
      };
    }
    if (!value) {
      return {
        ok: false,
        index: i,
        code: "model_mapping_no_target",
        error: `mapping ${JSON.stringify(key)} has no target model`,
      };
    }
    for (const id of [key, value]) {
      const problem = validateModelId(id);
      if (problem) return { ok: false, index: i, max: MAX_MODEL_ID_BYTES, ...problem };
    }
    if (key === value.toLowerCase()) {
      return {
        ok: false,
        index: i,
        code: "model_mapping_self",
        model: key,
        error: `mapping ${JSON.stringify(key)} points to itself`,
      };
    }
    if (cleaned.some((previous) => previous.key === key)) {
      return {
        ok: false,
        index: i,
        code: "model_mapping_duplicate",
        model: key,
        error: `source ${JSON.stringify(key)} is mapped more than once`,
      };
    }
    cleaned.push({ key, value });
  }
  for (const [i, mapping] of cleaned.entries()) {
    if (cleaned.some((other) => other.key === mapping.value.toLowerCase())) {
      return {
        ok: false,
        index: i,
        code: "model_mapping_chain",
        model: mapping.value,
        error: `target ${JSON.stringify(mapping.value)} is also a mapping source; mappings resolve in one hop`,
      };
    }
  }
  return { ok: true, rules: cleaned };
}

function readMappings(body: Json): ModelMappingRule[] | null {
  const list = body.mappings;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const rules: ModelMappingRule[] = [];
  for (const item of list) {
    if (!isRecord(item)) return null;
    const key = item.key ?? "";
    const value = item.value ?? "";
    if (!isString(key) || !isString(value)) return null;
    rules.push({ key, value });
  }
  return rules;
}

function readRules(value: unknown): PromptFilterRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: PromptFilterRule[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const rule: PromptFilterRule = {
      id: isString(item.id) ? item.id : "",
      name: isString(item.name) ? item.name : "",
      type: (isString(item.type) ? item.type : "") as PromptFilterRule["type"],
      match: isString(item.match) ? item.match : "",
      enabled: item.enabled === true,
    };
    // Go: `replace,omitempty`
    if (isString(item.replace) && item.replace) rule.replace = item.replace;
    rules.push(rule);
  }
  return rules;
}

/** Go's decode of {"headers":[...]}: absent or null is an empty list; a wrong type is null. */
function readResponseHeaders(value: unknown): ResponseHeaderRule[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const rules: ResponseHeaderRule[] = [];
  for (const item of value) {
    const fields = item === null ? {} : item;
    if (!isRecord(fields)) return null;
    const name = fields.name ?? "";
    const text = fields.value ?? "";
    const enabled = fields.enabled ?? false;
    if (!isString(name) || !isString(text) || !isBool(enabled)) return null;
    rules.push({ name, value: text, enabled });
  }
  return rules;
}

/** config/response_headers.go's English reason for a refused list. */
function responseHeaderReason(code: string, index: number, name: string, variable: string): string {
  const quoted = JSON.stringify(name);
  switch (code) {
    case "response_headers_too_many":
      return `at most ${MAX_RESPONSE_HEADERS} response headers are allowed`;
    case "response_header_name_empty":
      return `header ${index + 1} has no name`;
    case "response_header_name_too_long":
      return "header name is longer than 128 characters";
    case "response_header_name_forbidden":
      return `header ${quoted} is managed by the proxy and cannot be set`;
    case "response_header_name_invalid":
      return `header name ${quoted} is not a valid HTTP token`;
    case "response_header_name_duplicate":
      return `header ${quoted} is listed more than once`;
    case "response_header_value_empty":
      return `header ${quoted} has no value`;
    case "response_header_value_too_long":
      return `value of header ${quoted} is longer than 512 bytes`;
    case "response_header_unknown_variable":
      return `header ${quoted} uses unknown variable {${variable}}`;
    default:
      return `value of header ${quoted} contains line breaks or control characters`;
  }
}

export const handlers: HttpHandler[] = [
  http.get(apiUrl("/settings"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(mockDb.settings);
  }),

  http.post(apiUrl("/settings"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    const patch = body ? readSettingsPatch(body) : null;
    if (!patch) return invalidJson();
    if (
      patch.autoContinueMax !== undefined &&
      (patch.autoContinueMax < 1 || patch.autoContinueMax > MAX_AUTO_CONTINUE)
    ) {
      return jsonError(400, "autoContinueMax must be between 1 and 10");
    }
    const refresh = patch.usageRefreshIntervalMinutes;
    if (refresh !== undefined && refresh !== 0 && (refresh < 5 || refresh > 1440)) {
      return jsonError(400, "usageRefreshIntervalMinutes must be 0 (off) or between 5 and 1440", {
        code: "usage_refresh_interval_range",
      });
    }
    if (patch.routingMode !== undefined && !ROUTING_MODES.includes(patch.routingMode)) {
      return jsonError(400, 'routingMode must be "weighted" or "priority"', {
        code: "routing_mode_invalid",
      });
    }
    const resizeError = imageResizeRangeError(patch);
    if (resizeError) return resizeError;
    if (patch.password && [...patch.password].length < MIN_PASSWORD_RUNES) {
      return jsonError(400, "Password must be at least 8 characters");
    }
    // Turning the requirement on with no enabled key would lock every client out.
    if (
      patch.requireApiKey === true &&
      !mockDb.settings.requireApiKey &&
      !mockDb.apiKeys.some((key) => key.enabled)
    ) {
      return jsonError(409, "would lock out every client", { code: "api_key_lockout" });
    }
    const { password, ...rest } = patch;
    // An empty password is ignored, like Go. A real one would also revoke every admin session;
    // mock tokens stay valid, so only the next POST /session sees the new password.
    if (password) {
      claimMockPassword(password);
    }
    Object.assign(mockDb.settings, rest);
    return saved();
  }),

  http.get(apiUrl("/thinking"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const { suffix, openaiFormat, claudeFormat } = mockDb.thinking;
    // Empty stored values read back as their defaults.
    return HttpResponse.json({
      suffix: suffix || "-thinking",
      openaiFormat: openaiFormat || "reasoning_content",
      claudeFormat: claudeFormat || "thinking",
    });
  }),

  http.post(apiUrl("/thinking"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    if (!body) return invalidJson();
    const suffix = optional(body, "suffix", isString);
    const openaiFormat = optional(body, "openaiFormat", isString);
    const claudeFormat = optional(body, "claudeFormat", isString);
    if (suffix === null || openaiFormat === null || claudeFormat === null) return invalidJson();
    const formats = THINKING_FORMATS as readonly string[];
    if (openaiFormat && !formats.includes(openaiFormat)) {
      return jsonError(400, "Invalid openaiFormat, must be: reasoning_content, thinking, or think");
    }
    if (claudeFormat && !formats.includes(claudeFormat)) {
      return jsonError(400, "Invalid claudeFormat, must be: reasoning_content, thinking, or think");
    }
    // Not a patch: all three fields are written, an omitted one as "".
    mockDb.thinking = {
      suffix: suffix ?? "",
      openaiFormat: (openaiFormat ?? "") as ThinkingFormat,
      claudeFormat: (claudeFormat ?? "") as ThinkingFormat,
    };
    return saved();
  }),

  http.get(apiUrl("/model-mappings"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ mappings: mockDb.modelMappings, defaults: defaultModelMappings() });
  }),

  http.post(apiUrl("/model-mappings"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    const input = body ? readMappings(body) : null;
    if (!input) return invalidJson();
    const result = normalizeMappings(input);
    if (!result.ok) {
      const { ok: _ok, error, ...fields } = result;
      return jsonError(400, error, fields);
    }
    mockDb.modelMappings = result.rules;
    return saved();
  }),

  http.get(apiUrl("/endpoint"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(mockDb.endpoint);
  }),

  http.post(apiUrl("/endpoint"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    if (!body) return invalidJson();
    const preferred = optional(body, "preferredEndpoint", isString);
    const fallback = optional(body, "endpointFallback", isBool);
    if (preferred === null || fallback === null) return invalidJson();
    if (!preferred || !(ENDPOINTS as readonly string[]).includes(preferred)) {
      return jsonError(400, "Invalid endpoint, must be: auto, kiro, codewhisperer, or amazonq");
    }
    mockDb.endpoint = {
      preferredEndpoint: preferred as PreferredEndpoint,
      endpointFallback: fallback ?? mockDb.endpoint.endpointFallback,
    };
    return saved();
  }),

  http.get(apiUrl("/upstream"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ ...mockDb.upstream, apiRegions: [...API_REGIONS] });
  }),

  http.post(apiUrl("/upstream"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    if (!body) return invalidJson();
    const domain = optional(body, "apiDomain", isString);
    const apiRegion = optional(body, "apiRegion", isString);
    const authRegion = optional(body, "authRegion", isString);
    if (domain === null || apiRegion === null || authRegion === null) return invalidJson();
    // Patch: an omitted field keeps its value, '' clears a region (or resets the domain).
    const next = { ...mockDb.upstream };
    if (domain !== undefined) {
      const value = domain.trim().toLowerCase() || "amazonaws";
      if (!(API_DOMAINS as readonly string[]).includes(value)) {
        return jsonError(400, "Invalid apiDomain, must be: amazonaws or kiro", {
          code: "invalid_api_domain",
        });
      }
      next.apiDomain = value as ApiDomain;
    }
    if (apiRegion !== undefined) {
      const value = apiRegion.trim().toLowerCase();
      if (value && !API_REGIONS.includes(value)) {
        return jsonError(400, "apiRegion must be us-east-1 or eu-central-1", {
          code: "invalid_region",
        });
      }
      next.apiRegion = value;
    }
    if (authRegion !== undefined) {
      const value = authRegion.trim().toLowerCase();
      if (value && !AWS_REGION.test(value)) {
        return jsonError(400, "Invalid authRegion", { code: "invalid_region" });
      }
      next.authRegion = value;
    }
    mockDb.upstream = next;
    return saved();
  }),

  http.get(apiUrl("/proxy"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(mockDb.proxy);
  }),

  http.post(apiUrl("/proxy"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    const proxyURL = body ? optional(body, "proxyURL", isString) : null;
    if (proxyURL === null) return invalidJson();
    const url = (proxyURL ?? "").trim();
    if (url && !PROXY_SCHEMES.some((scheme) => url.startsWith(scheme))) {
      return jsonError(400, "proxyURL must start with http://, https://, socks5://, or socks5h://");
    }
    mockDb.proxy = { proxyURL: url };
    return saved();
  }),

  http.get(apiUrl("/count-tokens"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(countTokensConfig());
  }),

  // apiUpdateCountTokens: omitted fields keep their value, an empty URL clears everything, and a
  // URL on another origin drops the saved key.
  http.post(apiUrl("/count-tokens"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    if (!body) return invalidJson();
    const rawUrl = optional(body, "countTokensApiUrl", isString);
    const rawAuth = optional(body, "countTokensAuthType", isString);
    const rawKey = optional(body, "countTokensApiKey", isString);
    const clearKey = optional(body, "clearApiKey", isBool);
    if (rawUrl === null || rawAuth === null || rawKey === null || clearKey === null) {
      return invalidJson();
    }
    const current = mockDb.countTokens;
    const url = rawUrl === undefined ? current.url : rawUrl.trim();
    if (!url) {
      mockDb.countTokens = { url: "", authType: "x-api-key", key: "" };
      return saved();
    }
    const authType =
      rawAuth === undefined ? current.authType : rawAuth.trim().toLowerCase() || "x-api-key";
    const key = (rawKey ?? "").trim();
    if (!validCountTokensUrl(url)) {
      return jsonError(400, "countTokensApiUrl must start with http:// or https://", {
        code: "count_tokens_url_invalid",
      });
    }
    if (!(COUNT_TOKENS_AUTH_TYPES as readonly string[]).includes(authType)) {
      return jsonError(400, 'countTokensAuthType must be "x-api-key" or "bearer"', {
        code: "count_tokens_auth_type",
      });
    }
    if (key.length > MAX_COUNT_TOKENS_KEY || /[^\x21-\x7e]/.test(key)) {
      return jsonError(400, "countTokensApiKey must be printable ASCII without spaces", {
        code: "count_tokens_key_invalid",
      });
    }
    // A blank key survives only while the URL stays on the same origin.
    let nextKey = clearKey || !sameCountTokensOrigin(current.url, url) ? "" : current.key;
    if (key) nextKey = key;
    mockDb.countTokens = { url, authType: authType as CountTokensAuthType, key: nextKey };
    return saved();
  }),

  http.get(apiUrl("/prompt-filter"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ ...mockDb.promptFilter, rules: [...mockDb.promptFilter.rules] });
  }),

  http.post(apiUrl("/prompt-filter"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    if (!body) return invalidJson();
    const next = { ...mockDb.promptFilter };
    for (const key of ["filterClaudeCode", "filterEnvNoise", "filterStripBoundaries"] as const) {
      const value = optional(body, key, isBool);
      if (value === null) return invalidJson();
      if (value !== undefined) next[key] = value;
    }
    // Omitted or null rules keep the current list; [] clears it.
    if (body.rules !== undefined && body.rules !== null) {
      const rules = readRules(body.rules);
      if (!rules) return invalidJson();
      next.rules = rules;
    }
    mockDb.promptFilter = next;
    return saved();
  }),

  http.get(apiUrl("/log-retention"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const times = mockDb.requests.map((r) => r.ts);
    return HttpResponse.json({
      ...mockDb.logRetention,
      oldestRequestTs: times.length > 0 ? Math.min(...times) : 0,
    });
  }),

  http.post(apiUrl("/log-retention"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    const days = body ? optional(body, "days", isInteger) : null;
    if (days === null) return invalidJson();
    if (days === undefined || days < 0 || days > MAX_LOG_RETENTION_DAYS) {
      return jsonError(400, `days must be between 0 and ${MAX_LOG_RETENTION_DAYS}`, {
        code: "log_retention_range",
      });
    }
    // Go also starts a prune at once; the mock keeps its rows.
    mockDb.logRetention.days = days;
    return saved();
  }),

  http.get(apiUrl("/response-headers"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({
      headers: mockDb.responseHeaders.map((rule) => ({ ...rule })),
      variables: [...RESPONSE_HEADER_VARIABLES],
      max: MAX_RESPONSE_HEADERS,
    });
  }),

  // Replaces the whole list; a refused entry answers 400 with its code, index and params.
  http.post(apiUrl("/response-headers"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readObject(request);
    const input = body ? readResponseHeaders(body.headers) : null;
    if (!input) return invalidJson();
    const problem = listProblem(input);
    if (problem) {
      const { index, code, params } = problem;
      const name = index >= 0 ? normalizeHeaders([input[index]])[0].name : "";
      const variable = typeof params?.variable === "string" ? params.variable : "";
      return jsonError(400, responseHeaderReason(code, index, name, variable), {
        code,
        index,
        ...params,
      });
    }
    mockDb.responseHeaders = normalizeHeaders(input);
    return saved();
  }),

  http.post(apiUrl("/stats/reset"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    mockDb.requests = [];
    mockDb.errors = [];
    mockDb.modelMix = [];
    mockDb.logRetention.archivedRequests = 0;
    mockDb.startedAt = mockNowUnix();
    publishMockEvent("stats_reset");
    return HttpResponse.json(OK);
  }),
];
