import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { SuccessResponse } from "./types";

/** `unknown` until the first check or connection. */
export type PoolProxyStatus = "unknown" | "ok" | "failed";

/**
 * Times are Unix milliseconds; lastError is redacted English from the server. errorCode names the
 * last failure (connect, timeout, dns, tls, auth, auth_required, tunnel, socks) and errorStatus is
 * the proxy's answer to CONNECT when it refused one; both are absent from servers before them.
 */
export interface PoolProxyHealth {
  status: PoolProxyStatus;
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
  /** Accounts without their own proxy that are on this one. */
  accounts: number;
  health: PoolProxyHealth;
}

export type ProxyPoolMode = "on" | "off";

export interface ProxyPoolView {
  mode: ProxyPoolMode;
  directFallback: boolean;
  /** Minutes between background checks; 0 is off. */
  checkIntervalMin: number;
  proxies: PoolProxy[];
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
}

async function getProxyPool(): Promise<ProxyPoolView> {
  const res = await apiRequest<Partial<ProxyPoolView>>("/proxy-pool");
  return {
    mode: res.mode === "on" ? "on" : "off",
    directFallback: res.directFallback === true,
    checkIntervalMin: res.checkIntervalMin ?? 10,
    proxies: res.proxies ?? [],
    assignments: res.assignments ?? {},
  };
}

export function proxyPoolQuery() {
  return queryOptions({ queryKey: queryKeys.settings.proxyPool(), queryFn: getProxyPool });
}

const proxyPath = (id: string, suffix = "") =>
  `/proxy-pool/proxies/${encodeURIComponent(id)}${suffix}`;

/** 400 `proxy_pool_empty` when it turns the pool on while it has no proxies. */
export function updateProxyPoolSettings(body: ProxyPoolSettingsPatch): Promise<ProxyPoolView> {
  return apiRequest("/proxy-pool/settings", { method: "PUT", body });
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

/** Answers within about 15 s; checks still running land later through settings_changed. */
export function checkAllPoolProxies(): Promise<ProxyPoolView> {
  return apiRequest("/proxy-pool/check", { method: "POST" });
}
