import { queryOptions } from "@tanstack/react-query";
import {
  API_KEY_USAGE_RANGES,
  type ApiKeyUsageBreakdown,
  type ApiKeyUsageBreakdownItem,
  type ApiKeyUsageEntry,
  type ApiKeyUsageKind,
  type ApiKeyUsageRange,
  type ApiKeyUsageResponse,
  type ApiKeyUsageTotals,
  browserTzOffset,
} from "@/lib/api/api-key-usage";
import {
  clearUserToken,
  getUserToken,
  setUserToken,
  subscribeUserSession,
} from "@/lib/auth/user-session";
import { queryClient } from "@/lib/query-client";
import type { TimeBucket } from "@/lib/time-buckets";
import { apiRequest } from "./client";
import { ApiError, isApiError } from "./errors";
import { queryKeys } from "./query-keys";
import {
  REQUEST_ENDPOINTS,
  REQUEST_ERROR_TYPES,
  type RequestEndpoint,
  type RequestErrorType,
} from "./types";

// The API key holder's panel (/user/api, proxy/user_api.go): one key's status, limits, usage and
// requests, signed in with the key itself. Every answer is normalised, so a missing or unknown
// field reads as a safe default and nothing about accounts or other keys gets through.

export const USER_API_BASE = "/user/api";

/** GET /key: the signed-in key, the admin apiKeyView's fields a holder may see. */
export interface UserKey {
  id: string;
  /** "" when the key has no name. */
  name: string;
  /** Never the secret: first 6 + "****" + last 4. */
  keyMasked: string;
  enabled: boolean;
  /** `expiresAt` has passed: requests get 401. */
  expired: boolean;
  /** unix s */
  createdAt: number;
  /** unix s; 0 = never used. */
  lastUsedAt: number;
  /** unix s; 0 = never expires. */
  expiresAt: number;
  /** 0 = unlimited. */
  tokenLimit: number;
  tokensUsed: number;
  /** 0 = unlimited. */
  creditLimit: number;
  creditsUsed: number;
  /** 0 = unlimited. */
  callLimit: number;
  /** Requests that finished OK: what `callLimit` counts. */
  successfulCalls: number;
  requestsCount: number;
  /** Requests per minute; 0 = unlimited. */
  rpmLimit: number;
  /** Empty = every model. */
  allowedModels: string[];
  /**
   * The server's "Require API key". Off, calls to its own address are not checked for a key and
   * count for no key; calls through the public link always count. True when a server leaves it out.
   */
  keysRequired: boolean;
}

/** GET /usage: the admin usage response, with only this key in `keys`. */
export type UserUsage = ApiKeyUsageResponse;
/** GET /usage/breakdown: by model; `accounts` is always empty. */
export type UserUsageBreakdown = ApiKeyUsageBreakdown;
export type UserUsageRange = ApiKeyUsageRange;

export type UserRequestStatus = "all" | "success" | "error";
export const USER_REQUEST_STATUSES: readonly UserRequestStatus[] = ["all", "success", "error"];

/** One of the key's logged requests: no account, message, body or conversation. */
export interface UserRequest {
  /** unix s */
  ts: number;
  /** "" for requests rejected before a model was read. */
  model: string;
  /** "" on rows logged before endpoints were. */
  endpoint: RequestEndpoint | "";
  inTokens: number;
  outTokens: number;
  /** in + out (cache is a subset of in) */
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  success: boolean;
  /** HTTP status the client got; 0 when unknown. */
  status: number;
  /** 0 when not recorded. */
  durationMs: number;
  /** "" on success; a type this UI does not know reads as "unknown". */
  errorType: RequestErrorType | "";
  /** "req_" + 24 hex, the {request_id} the client got; "" when absent. */
  requestId: string;
}

export interface UserRequestPage {
  requests: UserRequest[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserRequestsParams {
  /** >= 1, default 1 */
  page?: number;
  /** 1..100, default 25 */
  pageSize?: number;
  /** default "all" */
  status?: UserRequestStatus;
}

export const USER_REQUESTS_PAGE_SIZE = 25;
export const USER_REQUESTS_MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function record(value: unknown): Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Loose)
    : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A count or a time: whole and never negative. */
function count(value: unknown): number {
  return Math.max(0, Math.round(num(value)));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const TIME_BUCKETS: readonly TimeBucket[] = ["hour", "day", "week", "month", "year"];
const USAGE_KINDS: readonly ApiKeyUsageKind[] = ["key", "deleted", "invalid", "none"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeUserKey(value: unknown): UserKey {
  const res = record(value);
  return {
    id: str(res.id),
    name: str(res.name).trim(),
    keyMasked: str(res.keyMasked),
    enabled: res.enabled === true,
    expired: res.expired === true,
    createdAt: count(res.createdAt),
    lastUsedAt: count(res.lastUsedAt),
    expiresAt: count(res.expiresAt),
    tokenLimit: count(res.tokenLimit),
    tokensUsed: count(res.tokensUsed),
    creditLimit: Math.max(0, num(res.creditLimit)),
    creditsUsed: Math.max(0, num(res.creditsUsed)),
    callLimit: count(res.callLimit),
    successfulCalls: count(res.successfulCalls),
    requestsCount: count(res.requestsCount),
    rpmLimit: count(res.rpmLimit),
    allowedModels: list(res.allowedModels).filter(
      (model): model is string => typeof model === "string" && model !== "",
    ),
    keysRequired: res.keysRequired !== false,
  };
}

function normalizeTotals(value: unknown): ApiKeyUsageTotals {
  const res = record(value);
  const inTokens = count(res.inTokens);
  const outTokens = count(res.outTokens);
  return {
    requests: count(res.requests),
    succeeded: count(res.succeeded),
    failed: count(res.failed),
    inTokens,
    outTokens,
    tokens: typeof res.tokens === "number" ? count(res.tokens) : inTokens + outTokens,
    credits: Math.max(0, num(res.credits)),
  };
}

function optionalTotals(value: unknown): ApiKeyUsageTotals | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? normalizeTotals(value)
    : undefined;
}

/** One series entry per bucket, so a chart never indexes past either list. */
function normalizeEntry(value: unknown, buckets: number): ApiKeyUsageEntry {
  const res = record(value);
  const series = list(res.series).slice(0, buckets).map(normalizeTotals);
  while (series.length < buckets) series.push(normalizeTotals(null));
  const name = str(res.name);
  const keyMasked = str(res.keyMasked);
  const earlier = optionalTotals(res.earlier);
  return {
    id: str(res.id),
    kind: oneOf(res.kind, USAGE_KINDS, "key"),
    ...(name ? { name } : {}),
    ...(keyMasked ? { keyMasked } : {}),
    totals: normalizeTotals(res.totals),
    series,
    ...(earlier ? { earlier } : {}),
  };
}

export function normalizeUserUsage(value: unknown, range: UserUsageRange = "24h"): UserUsage {
  const res = record(value);
  const buckets = list(res.buckets).map(num);
  const earlier = optionalTotals(res.earlier);
  return {
    range: oneOf(res.range, API_KEY_USAGE_RANGES, range),
    bucket: oneOf(res.bucket, TIME_BUCKETS, "day"),
    bucketSeconds: count(res.bucketSeconds),
    tzOffset: Math.round(num(res.tzOffset)),
    from: count(res.from),
    to: count(res.to),
    nowUnix: count(res.nowUnix),
    buckets,
    totals: normalizeTotals(res.totals),
    keys: list(res.keys).map((entry) => normalizeEntry(entry, buckets.length)),
    ...(earlier ? { earlier } : {}),
  };
}

function normalizeBreakdownItem(value: unknown): ApiKeyUsageBreakdownItem {
  const res = record(value);
  return {
    id: str(res.id),
    requests: count(res.requests),
    succeeded: count(res.succeeded),
    failed: count(res.failed),
    tokens: count(res.tokens),
    credits: Math.max(0, num(res.credits)),
  };
}

export function normalizeUserUsageBreakdown(
  value: unknown,
  range: UserUsageRange = "24h",
): UserUsageBreakdown {
  const res = record(value);
  return {
    ref: str(res.ref),
    range: oneOf(res.range, API_KEY_USAGE_RANGES, range),
    from: count(res.from),
    to: count(res.to),
    models: list(res.models).map(normalizeBreakdownItem),
    // Accounts are never shown to a key holder, whatever the server sends.
    accounts: [],
  };
}

export function normalizeUserRequest(value: unknown): UserRequest {
  const res = record(value);
  const success = res.success === true;
  const inTokens = count(res.inTokens);
  const outTokens = count(res.outTokens);
  const errorType = str(res.errorType);
  return {
    ts: count(res.ts),
    model: str(res.model),
    endpoint: oneOf<RequestEndpoint | "">(res.endpoint, REQUEST_ENDPOINTS, ""),
    inTokens,
    outTokens,
    totalTokens:
      typeof res.totalTokens === "number" ? count(res.totalTokens) : inTokens + outTokens,
    cacheReadTokens: count(res.cacheReadTokens),
    cacheWriteTokens: count(res.cacheWriteTokens),
    credits: Math.max(0, num(res.credits)),
    success,
    status: count(res.status),
    durationMs: count(res.durationMs),
    errorType: success || !errorType ? "" : oneOf(errorType, REQUEST_ERROR_TYPES, "unknown"),
    requestId: str(res.requestId),
  };
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return USER_REQUESTS_PAGE_SIZE;
  return Math.min(USER_REQUESTS_MAX_PAGE_SIZE, Math.max(1, Math.round(value)));
}

export function normalizeUserRequestPage(
  value: unknown,
  params: UserRequestsParams = {},
): UserRequestPage {
  const res = record(value);
  const page = count(res.page) || Math.max(1, Math.round(params.page ?? 1));
  return {
    requests: list(res.requests).map(normalizeUserRequest),
    total: count(res.total),
    page,
    pageSize: count(res.pageSize) || clampPageSize(params.pageSize),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface UserRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

function expiredError(): ApiError {
  return new ApiError({
    status: 401,
    serverMessage: "Unauthorized",
    body: { error: "Unauthorized", code: "user_session_expired" },
  });
}

/**
 * A request with the stored token in X-User-Token. Without a token nothing is sent; a 401 for
 * the token this request carried ends the session ("expired"), but not one that replaced it.
 */
async function userRequest<T>(path: string, options: UserRequestOptions = {}): Promise<T> {
  const token = getUserToken();
  if (!token) throw expiredError();
  try {
    return await apiRequest<T>(path, {
      ...options,
      auth: false,
      base: USER_API_BASE,
      headers: { "X-User-Token": token },
    });
  } catch (error) {
    if (isApiError(error) && error.status === 401 && getUserToken() === token) {
      clearUserToken("expired");
    }
    throw error;
  }
}

/** Unix seconds as the contract has it; a ms epoch (like the admin session's) is taken as is. */
function expiryMs(value: unknown): number {
  const at = num(value);
  if (at <= 0) return 0;
  return at > 1e12 ? at : at * 1000;
}

/** POST /session with the full key; stores the token like the admin sign-in. */
export async function signInWithKey(key: string, staySignedIn: boolean): Promise<void> {
  const res = record(
    await apiRequest<unknown>("/session", {
      method: "POST",
      body: { key },
      auth: false,
      base: USER_API_BASE,
    }),
  );
  const token = str(res.token);
  if (!token) throw new ApiError({ status: 401, serverMessage: "Unauthorized", body: res });
  setUserToken(token, staySignedIn, expiryMs(res.expiresAt));
}

/** Revokes the token server-side when possible; the local session ends either way. */
export async function signOutUser(): Promise<void> {
  const token = getUserToken();
  try {
    if (token) {
      await apiRequest("/session", {
        method: "DELETE",
        auth: false,
        base: USER_API_BASE,
        headers: { "X-User-Token": token },
      });
    }
  } catch {
    // Already expired or unreachable: nothing left to revoke.
  }
  clearUserToken("signed-out");
}

export async function getUserKey(signal?: AbortSignal): Promise<UserKey> {
  return normalizeUserKey(await userRequest("/key", { signal }));
}

export async function getUserUsage(
  range: UserUsageRange,
  tzOffset: number,
  signal?: AbortSignal,
): Promise<UserUsage> {
  const res = await userRequest("/usage", { query: { range, tzOffset }, signal });
  return normalizeUserUsage(res, range);
}

export async function getUserUsageBreakdown(
  range: UserUsageRange,
  tzOffset: number,
  signal?: AbortSignal,
): Promise<UserUsageBreakdown> {
  const res = await userRequest("/usage/breakdown", { query: { range, tzOffset }, signal });
  return normalizeUserUsageBreakdown(res, range);
}

export async function getUserRequests(
  params: UserRequestsParams = {},
  signal?: AbortSignal,
): Promise<UserRequestPage> {
  const page = Math.max(1, Math.round(params.page ?? 1));
  const pageSize = clampPageSize(params.pageSize);
  const status = params.status ?? "all";
  const res = await userRequest("/requests", { query: { page, pageSize, status }, signal });
  return normalizeUserRequestPage(res, { page, pageSize, status });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// The panel has no event stream: it polls, like the admin usage sheet.

export function userKeyQuery() {
  return queryOptions({
    queryKey: queryKeys.userPanel.key(),
    queryFn: ({ signal }) => getUserKey(signal),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/** All time scans the whole log for bars of a day or more, so it polls every 5 minutes. */
export function userUsageQuery(range: UserUsageRange, tzOffset = browserTzOffset()) {
  return queryOptions({
    queryKey: queryKeys.userPanel.usage(range, tzOffset),
    queryFn: ({ signal }) => getUserUsage(range, tzOffset, signal),
    refetchInterval: range === "all" ? 300_000 : 60_000,
    staleTime: 30_000,
  });
}

export function userUsageBreakdownQuery(range: UserUsageRange, tzOffset = browserTzOffset()) {
  return queryOptions({
    queryKey: queryKeys.userPanel.breakdown(range, tzOffset),
    queryFn: ({ signal }) => getUserUsageBreakdown(range, tzOffset, signal),
    refetchInterval: range === "all" ? 300_000 : 60_000,
    staleTime: 30_000,
  });
}

export function userRequestsQuery(params: UserRequestsParams = {}) {
  const key = {
    page: Math.max(1, Math.round(params.page ?? 1)),
    pageSize: clampPageSize(params.pageSize),
    status: params.status ?? "all",
  };
  return queryOptions({
    queryKey: queryKeys.userPanel.requests(key),
    queryFn: ({ signal }) => getUserRequests(key, signal),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

// A sign-in, sign-out or expiry must not leave the previous key's data in the cache.
subscribeUserSession(() => {
  queryClient.removeQueries({ queryKey: queryKeys.userPanel.all });
});
