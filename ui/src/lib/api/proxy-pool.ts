import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { SuccessResponse } from "./types";

/**
 * `unknown` until the first check or connection. `failed` only once a proxy failed `maxFailures`
 * times in a row: it is then out of rotation until a check passes.
 */
export type PoolProxyStatus = "unknown" | "ok" | "failed";

/**
 * What a proxy shows as: `unhealthy` is failing but still in rotation, `auto_disabled` failed
 * `maxFailures` times in a row, `off` is the admin's switch. A detected proxy is never
 * `auto_disabled` or `off`.
 */
export type PoolProxyState = "healthy" | "unknown" | "unhealthy" | "auto_disabled" | "off";

/**
 * Times are Unix milliseconds; lastError is redacted English from the server. errorCode names the
 * last failure (connect, timeout, dns, tls, auth, auth_required, tunnel, socks) and errorStatus is
 * the proxy's answer to CONNECT when it refused one; both are absent from servers before them.
 */
export interface PoolProxyHealth {
  status: PoolProxyStatus;
  /** Failed checks and connections since the last success. */
  failures?: number;
  checkedAt?: number;
  failedAt?: number;
  latencyMs?: number;
  lastError?: string;
  errorCode?: string;
  errorStatus?: number;
}

/** A pool proxy as the server shows it: the password is never sent, only whether one is set. */
export interface PoolProxy {
  id: string;
  label?: string;
  /** scheme://host:port, without sign-in. */
  url: string;
  username?: string;
  hasPassword: boolean;
  createdAt?: number;
  /** The admin's switch: a proxy switched off is never used or checked. */
  enabled: boolean;
  state: PoolProxyState;
  /** Accounts without their own proxy that are on this one. */
  accounts: number;
  health: PoolProxyHealth;
}

/**
 * A proxy in use outside the pool: the global proxy or accounts' own. It is checked like a pool
 * proxy and never shared; one without a sign-in joins the pool only through Add to pool.
 */
export interface DetectedProxy {
  id: string;
  /** scheme://host:port, without sign-in. */
  url: string;
  username?: string;
  hasPassword: boolean;
  /** The server-wide outbound proxy. */
  global: boolean;
  /** Accounts with this proxy as their own. */
  accountIds: string[];
  /** The pool holds the same address without a sign-in. */
  inPool: boolean;
  /** No sign-in and not in the pool yet. */
  canAdopt: boolean;
  state: PoolProxyState;
  health: PoolProxyHealth;
}

/** How many proxies are in each state, detected ones included. */
export interface ProxyPoolCounts {
  healthy: number;
  unhealthy: number;
  autoDisabled: number;
  off: number;
  unknown: number;
}

export type ProxyPoolMode = "on" | "off";

export interface ProxyPoolView {
  mode: ProxyPoolMode;
  directFallback: boolean;
  /** Minutes between background checks; 0 is off. */
  checkIntervalMin: number;
  /** Failures in a row that take a proxy out of rotation (3). */
  maxFailures: number;
  proxies: PoolProxy[];
  detected: DetectedProxy[];
  counts: ProxyPoolCounts;
  /** Account id -> pool proxy id. */
  assignments: Record<string, string>;
}

export interface ProxyPoolSettingsPatch {
  mode?: ProxyPoolMode;
  directFallback?: boolean;
  checkIntervalMin?: number;
}

/**
 * An add or an edit. On an edit an omitted field keeps the stored value, and `password: ""`
 * clears the saved password.
 */
export interface PoolProxyInput {
  label?: string;
  url?: string;
  username?: string;
  password?: string;
  enabled?: boolean;
}

const EMPTY_COUNTS: ProxyPoolCounts = {
  healthy: 0,
  unhealthy: 0,
  autoDisabled: 0,
  off: 0,
  unknown: 0,
};

/** A proxy from a server before the switch and states: on, with a state read off its health. */
function normalizeProxy(proxy: PoolProxy): PoolProxy {
  const enabled = proxy.enabled !== false;
  if (proxy.state) return { ...proxy, enabled };
  const status = proxy.health?.status;
  const state: PoolProxyState = !enabled
    ? "off"
    : status === "failed"
      ? "auto_disabled"
      : status === "ok"
        ? "healthy"
        : "unknown";
  return { ...proxy, enabled, state };
}

async function getProxyPool(): Promise<ProxyPoolView> {
  return normalizeView(await apiRequest<Partial<ProxyPoolView>>("/proxy-pool"));
}

/** Fills what an older server leaves out. */
export function normalizeView(res: Partial<ProxyPoolView>): ProxyPoolView {
  return {
    mode: res.mode === "on" ? "on" : "off",
    directFallback: res.directFallback === true,
    checkIntervalMin: res.checkIntervalMin ?? 10,
    maxFailures: res.maxFailures ?? 3,
    proxies: (res.proxies ?? []).map(normalizeProxy),
    detected: res.detected ?? [],
    counts: res.counts ?? EMPTY_COUNTS,
    assignments: res.assignments ?? {},
  };
}

export function proxyPoolQuery() {
  return queryOptions({ queryKey: queryKeys.settings.proxyPool(), queryFn: getProxyPool });
}

const proxyPath = (id: string, suffix = "") =>
  `/proxy-pool/proxies/${encodeURIComponent(id)}${suffix}`;

/** 400 `proxy_pool_empty` when it turns the pool on while it has no proxies. */
export async function updateProxyPoolSettings(
  body: ProxyPoolSettingsPatch,
): Promise<ProxyPoolView> {
  return normalizeView(await apiRequest("/proxy-pool/settings", { method: "PUT", body }));
}

/** 201; 400 `proxy_pool_invalid` (detail names the field), 409 `proxy_pool_duplicate`. */
export function addPoolProxy(body: PoolProxyInput): Promise<{ proxy: PoolProxy }> {
  return apiRequest("/proxy-pool/proxies", { method: "POST", body });
}

export function updatePoolProxy(id: string, body: PoolProxyInput): Promise<{ proxy: PoolProxy }> {
  return apiRequest(proxyPath(id), { method: "PUT", body });
}

export function removePoolProxy(id: string): Promise<SuccessResponse> {
  return apiRequest(proxyPath(id), { method: "DELETE" });
}

/** Connects through the proxy to the Kiro host now; answers within about 10 s. */
export function checkPoolProxy(id: string): Promise<{ proxy: PoolProxy }> {
  return apiRequest(proxyPath(id, "/check"), { method: "POST" });
}

/** Switches a proxy on or off. Off moves its accounts to the other proxies at once. */
export function setPoolProxyEnabled(id: string, enabled: boolean): Promise<{ proxy: PoolProxy }> {
  return apiRequest(proxyPath(id), { method: "PUT", body: { enabled } });
}

/** Answers within about 15 s; checks still running land later through settings_changed. */
export async function checkAllPoolProxies(): Promise<ProxyPoolView> {
  return normalizeView(await apiRequest("/proxy-pool/check", { method: "POST" }));
}

const detectedPath = (id: string, suffix: string) =>
  `/proxy-pool/detected/${encodeURIComponent(id)}${suffix}`;

/** Checks a detected proxy now, like a pool proxy. */
export function checkDetectedProxy(id: string): Promise<{ detected: DetectedProxy }> {
  return apiRequest(detectedPath(id, "/check"), { method: "POST" });
}

/**
 * Adds an unauthenticated detected proxy to the pool, where any account may then use it. 201;
 * 400 `proxy_pool_detected_sign_in` for one with a sign-in, 409 `proxy_pool_duplicate`.
 */
export function adoptDetectedProxy(id: string): Promise<{ proxy: PoolProxy }> {
  return apiRequest(detectedPath(id, "/adopt"), { method: "POST" });
}
