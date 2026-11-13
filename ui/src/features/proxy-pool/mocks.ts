import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  PoolProxy,
  PoolProxyHealth,
  ProxyPoolMode,
  ProxyPoolView,
} from "@/lib/api/proxy-pool";
import { mockNowUnix } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";

// Mirrors the Go proxy pool API (proxy/proxy_pool_api.go, proxypool/url.go): the same
// validation, codes and masking. The password is kept here and never sent back.

const MAX_PROXIES = 100;
const MAX_LABEL = 64;
const SCHEMES = ["http", "https", "socks5", "socks5h"];

interface StoredProxy {
  id: string;
  label: string;
  url: string;
  username: string;
  password: string;
  createdAt: number;
  health: PoolProxyHealth;
}

interface PoolState {
  mode: ProxyPoolMode;
  directFallback: boolean;
  checkIntervalMin: number;
  proxies: StoredProxy[];
  assignments: Record<string, string>;
  nextId: number;
}

function initialState(): PoolState {
  return {
    mode: "off",
    directFallback: false,
    checkIntervalMin: 10,
    proxies: [],
    assignments: {},
    nextId: 1,
  };
}

let state = initialState();

/** Back to an empty pool with the defaults; tests call it before each case. */
export function resetProxyPoolMock(): void {
  state = initialState();
}

/** Seeds the pool directly (tests): passwords stay server-side as in Go. */
export function seedProxyPoolMock(next: Partial<Omit<PoolState, "nextId">>): void {
  state = { ...initialState(), ...next, nextId: (next.proxies?.length ?? 0) + 1 };
}

function view(proxy: StoredProxy): PoolProxy {
  const accounts = Object.values(state.assignments).filter((id) => id === proxy.id).length;
  return {
    id: proxy.id,
    ...(proxy.label ? { label: proxy.label } : {}),
    url: proxy.url,
    ...(proxy.username ? { username: proxy.username } : {}),
    hasPassword: proxy.password !== "",
    createdAt: proxy.createdAt,
    accounts,
    health: { ...proxy.health },
  };
}

function poolView(): ProxyPoolView {
  return {
    mode: state.mode,
    directFallback: state.directFallback,
    checkIntervalMin: state.checkIntervalMin,
    proxies: state.proxies.map(view),
    assignments: { ...state.assignments },
  };
}

function changed(): void {
  publishMockEvent("settings_changed", "proxy-pool");
}

type Json = Record<string, unknown>;

async function readObject(request: Request): Promise<Json | null> {
  const body: unknown = await request.json().catch(() => undefined);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Json) : null;
}

function invalid(reason: string): Response {
  return jsonError(400, `invalid proxy: ${reason}`, { code: "proxy_pool_invalid", detail: reason });
}

function notFound(): Response {
  return jsonError(404, "proxy not found", { code: "proxy_pool_not_found" });
}

/** Go's parseProxyURL: scheme://host:port plus any user:pass@ it held. */
function parseUrl(raw: string): { base: string; user?: string; pass?: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "url is required" };
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([/?#].*)?$/i.exec(text);
  if (!match) return { error: "url is not a valid proxy URL" };
  const scheme = match[1].toLowerCase();
  if (!SCHEMES.includes(scheme)) {
    return { error: "url must start with http://, https://, socks5:// or socks5h://" };
  }
  if (match[3] && match[3] !== "/") return { error: "url must not have a path or query" };
  const authority = match[2];
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : undefined;
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const portMatch = /^(\[[^\]]+\]|[^:]*)(?::(\d*))?$/.exec(hostPort);
  const host = portMatch?.[1] ?? "";
  const port = portMatch?.[2] ?? "";
  if (!host || host === "[]") return { error: "url needs a host" };
  if (!port) return { error: "url needs a port" };
  const portNumber = Number(port);
  if (!(portNumber >= 1 && portNumber <= 65535)) return { error: "port must be from 1 to 65535" };
  const base = `${scheme}://${host.toLowerCase()}:${port}`;
  if (userinfo === undefined) return { base };
  const colon = userinfo.indexOf(":");
  return {
    base,
    user: decodeURIComponent(colon >= 0 ? userinfo.slice(0, colon) : userinfo),
    pass: colon >= 0 ? decodeURIComponent(userinfo.slice(colon + 1)) : "",
  };
}

/** Go's buildProxy: applies the body to `base` (undefined for a new proxy). */
function build(body: Json, base?: StoredProxy): StoredProxy | Response {
  const next: StoredProxy = base
    ? { ...base }
    : {
        id: "",
        label: "",
        url: "",
        username: "",
        password: "",
        createdAt: 0,
        health: { status: "unknown" },
      };
  if (typeof body.url === "string") {
    const parsed = parseUrl(body.url);
    if ("error" in parsed) return invalid(parsed.error);
    next.url = parsed.base;
    if (parsed.user !== undefined) {
      next.username = parsed.user;
      next.password = parsed.pass ?? "";
    }
  } else if (!base) {
    return invalid("url is required");
  }
  if (typeof body.username === "string") next.username = body.username.trim();
  if (typeof body.password === "string") next.password = body.password;
  if (typeof body.label === "string") next.label = body.label.trim();
  if ([...next.label].length > MAX_LABEL) return invalid("label must be at most 64 characters");
  if (next.password && !next.username) return invalid("a password needs a username");
  return next;
}

function duplicate(proxy: StoredProxy): boolean {
  return state.proxies.some(
    (other) =>
      other.id !== proxy.id && other.url === proxy.url && other.username === proxy.username,
  );
}

/** A deterministic check: an address on port 9 or with "dead" in it fails, others answer. */
function check(proxy: StoredProxy): void {
  const now = mockNowUnix() * 1000;
  if (/:9$|dead/.test(proxy.url)) {
    proxy.health = {
      status: "failed",
      checkedAt: now,
      failedAt: now,
      lastError: "connection refused or reset: proxyconnect tcp: connect: connection refused",
      errorCode: "connect",
    };
    return;
  }
  const latencyMs = 80 + ([...proxy.url].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 220);
  proxy.health = { ...proxy.health, status: "ok", checkedAt: now, latencyMs };
}

export const handlers: HttpHandler[] = [
  http.get(apiUrl("/proxy-pool"), async ({ request }) => {
    await mockDelay();
    return requireAuth(request) ?? HttpResponse.json(poolView());
  }),

  http.put(apiUrl("/proxy-pool/settings"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readObject(request);
    if (!body) return jsonError(400, "Invalid JSON", { code: "invalid_json" });
    const mode = body.mode;
    if (mode !== undefined && mode !== "on" && mode !== "off") {
      return invalid("proxyPoolMode must be on or off");
    }
    if (mode === "on" && state.mode !== "on" && state.proxies.length === 0) {
      return jsonError(400, "add a proxy to the pool before turning it on", {
        code: "proxy_pool_empty",
      });
    }
    const interval = body.checkIntervalMin;
    if (
      interval !== undefined &&
      (typeof interval !== "number" ||
        !Number.isInteger(interval) ||
        interval < 0 ||
        interval > 1440)
    ) {
      return invalid("checkIntervalMin must be between 0 and 1440");
    }
    if (mode !== undefined) state.mode = mode;
    if (typeof body.directFallback === "boolean") state.directFallback = body.directFallback;
    if (typeof interval === "number") state.checkIntervalMin = interval;
    changed();
    return HttpResponse.json(poolView());
  }),

  http.post(apiUrl("/proxy-pool/check"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    for (const proxy of state.proxies) check(proxy);
    changed();
    return HttpResponse.json(poolView());
  }),

  http.post(apiUrl("/proxy-pool/proxies"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readObject(request);
    if (!body) return jsonError(400, "Invalid JSON", { code: "invalid_json" });
    if (state.proxies.length >= MAX_PROXIES) {
      return jsonError(400, "the proxy pool is full", { code: "proxy_pool_full" });
    }
    const built = build(body);
    if (built instanceof Response) return built;
    if (duplicate(built)) {
      return jsonError(409, "this proxy is already in the pool", { code: "proxy_pool_duplicate" });
    }
    built.id = `px_mock${state.nextId++}`;
    built.createdAt = mockNowUnix() * 1000;
    state.proxies.push(built);
    changed();
    return HttpResponse.json({ proxy: view(built) }, { status: 201 });
  }),

  http.post(apiUrl("/proxy-pool/proxies/:id/check"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const proxy = state.proxies.find((item) => item.id === params.id);
    if (!proxy) return notFound();
    check(proxy);
    changed();
    return HttpResponse.json({ proxy: view(proxy) });
  }),

  http.put(apiUrl("/proxy-pool/proxies/:id"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const index = state.proxies.findIndex((item) => item.id === params.id);
    if (index < 0) return notFound();
    const body = await readObject(request);
    if (!body) return jsonError(400, "Invalid JSON", { code: "invalid_json" });
    const current = state.proxies[index];
    const built = build(body, current);
    if (built instanceof Response) return built;
    if (duplicate(built)) {
      return jsonError(409, "this proxy is already in the pool", { code: "proxy_pool_duplicate" });
    }
    if (
      built.url !== current.url ||
      built.username !== current.username ||
      built.password !== current.password
    ) {
      built.health = { status: "unknown" };
    }
    state.proxies[index] = built;
    changed();
    return HttpResponse.json({ proxy: view(built) });
  }),

  http.delete(apiUrl("/proxy-pool/proxies/:id"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const index = state.proxies.findIndex((item) => item.id === params.id);
    if (index < 0) return notFound();
    const [removed] = state.proxies.splice(index, 1);
    const rest = state.proxies.filter((item) => item.health.status !== "failed");
    for (const [account, id] of Object.entries(state.assignments)) {
      if (id !== removed.id) continue;
      if (rest.length > 0) state.assignments[account] = rest[0].id;
      else delete state.assignments[account];
    }
    changed();
    return HttpResponse.json({ success: true });
  }),
];
