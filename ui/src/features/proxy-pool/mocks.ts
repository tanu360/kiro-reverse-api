import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  DetectedProxy,
  PoolProxy,
  PoolProxyHealth,
  PoolProxyState,
  ProxyPoolCounts,
  ProxyPoolMode,
  ProxyPoolView,
} from "@/lib/api/proxy-pool";
import { type MockScenario, mockDb, mockNowUnix, mockScenario } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";

// Mirrors the Go proxy pool API (proxy/proxy_pool_api.go, proxypool/url.go): the same
// validation, codes and masking. The password is kept here and never sent back.

const MAX_PROXIES = 100;
/** Failures in a row that take a pool proxy out (proxypool.MaxFailures). */
const MAX_FAILURES = 3;
const MAX_LABEL = 64;
const SCHEMES = ["http", "https", "socks5", "socks5h"];

interface StoredProxy {
  id: string;
  label: string;
  url: string;
  username: string;
  password: string;
  createdAt: number;
  enabled: boolean;
  health: PoolProxyHealth;
}

interface PoolState {
  mode: ProxyPoolMode;
  directFallback: boolean;
  checkIntervalMin: number;
  proxies: StoredProxy[];
  assignments: Record<string, string>;
  nextId: number;
  /** Health of the detected proxies, by detected id. */
  detected: Record<string, PoolProxyHealth>;
  /** The dataset this state was made for: a scenario switch starts over. */
  scenario: MockScenario;
}

/** The full dataset's pool: one proxy in each state, with accounts spread over the healthy ones. */
function seededProxies(nowMs: number): StoredProxy[] {
  const minute = 60_000;
  const base = { username: "", password: "", enabled: true } as const;
  return [
    {
      ...base,
      id: "px_mock1",
      label: "Frankfurt VPS",
      url: "socks5://fra1.northwind.studio:1080",
      username: "kiro-pool",
      password: "pool-secret",
      createdAt: nowMs - 40 * 24 * 60 * minute,
      health: { status: "ok", checkedAt: nowMs - 4 * minute, latencyMs: 96 },
    },
    {
      ...base,
      id: "px_mock2",
      label: "Tokyo",
      url: "http://tyo.northwind.studio:3128",
      createdAt: nowMs - 21 * 24 * 60 * minute,
      health: { status: "ok", checkedAt: nowMs - 4 * minute, latencyMs: 212 },
    },
    {
      ...base,
      id: "px_mock3",
      label: "São Paulo",
      url: "socks5h://gru.northwind.studio:1080",
      createdAt: nowMs - 9 * 24 * 60 * minute,
      health: {
        status: "ok",
        failures: 1,
        checkedAt: nowMs - 4 * minute,
        lastError: "connection timed out: no connection through the proxy within 15s",
        errorCode: "timeout",
      },
    },
    {
      ...base,
      id: "px_mock4",
      label: "",
      url: "http://203.0.113.24:8080",
      createdAt: nowMs - 6 * 24 * 60 * minute,
      health: {
        status: "failed",
        failures: 3,
        checkedAt: nowMs - 4 * minute,
        failedAt: nowMs - 24 * minute,
        lastError: "proxy refused the tunnel: Forbidden",
        errorCode: "tunnel",
        errorStatus: 403,
      },
    },
    {
      ...base,
      id: "px_mock5",
      label: "Spare (maintenance)",
      url: "socks5://spare.northwind.studio:1080",
      enabled: false,
      createdAt: nowMs - 3 * 24 * 60 * minute,
      health: { status: "ok", checkedAt: nowMs - 3 * 24 * 60 * minute, latencyMs: 140 },
    },
  ];
}

function initialState(): PoolState {
  const scenario = mockScenario();
  const empty: PoolState = {
    mode: "off",
    directFallback: false,
    checkIntervalMin: 10,
    proxies: [],
    assignments: {},
    nextId: 1,
    detected: {},
    scenario,
  };
  if (scenario !== "full") return empty;
  const nowMs = mockNowUnix() * 1000;
  const proxies = seededProxies(nowMs);
  const serving = proxies.filter((proxy) => proxy.enabled && proxy.health.status !== "failed");
  const assignments: Record<string, string> = {};
  mockDb.accounts
    .filter((account) => !account.proxyURL)
    .slice(0, 24)
    .forEach((account, index) => {
      assignments[account.id] = serving[index % serving.length].id;
    });
  return { ...empty, mode: "on", proxies, assignments, nextId: proxies.length + 1 };
}

let state = initialState();

/** The state for the dataset now served: a reset or a scenario switch starts it over. */
function current(): PoolState {
  if (state.scenario !== mockScenario()) state = initialState();
  return state;
}

/** Back to an empty pool with the defaults; tests call it before each case. */
export function resetProxyPoolMock(): void {
  state = initialState();
}

type SeedProxy = Omit<StoredProxy, "enabled"> & { enabled?: boolean };

/** Seeds the pool directly (tests): passwords stay server-side as in Go; proxies start on. */
export function seedProxyPoolMock(
  next: Partial<Omit<PoolState, "nextId" | "scenario" | "proxies">> & { proxies?: SeedProxy[] },
): void {
  const proxies = (next.proxies ?? []).map((proxy) => ({
    ...proxy,
    enabled: proxy.enabled ?? true,
  }));
  // A test seeds the whole pool: the full dataset's proxies and assignments never leak in.
  state = { ...initialState(), assignments: {}, ...next, proxies, nextId: proxies.length + 1 };
}

/** proxypool's stateOf. */
function stateOf(enabled: boolean, health: PoolProxyHealth): PoolProxyState {
  if (!enabled) return "off";
  if (health.status === "failed") return "auto_disabled";
  if ((health.failures ?? 0) > 0) return "unhealthy";
  return health.status === "ok" ? "healthy" : "unknown";
}

/** proxypool's detectedStateOf: nothing disables a detected proxy. */
function detectedStateOf(health: PoolProxyHealth): PoolProxyState {
  if ((health.failures ?? 0) > 0 || health.status === "failed") return "unhealthy";
  return health.status === "ok" ? "healthy" : "unknown";
}

function view(proxy: StoredProxy): PoolProxy {
  const accounts = Object.values(current().assignments).filter((id) => id === proxy.id).length;
  return {
    id: proxy.id,
    ...(proxy.label ? { label: proxy.label } : {}),
    url: proxy.url,
    ...(proxy.username ? { username: proxy.username } : {}),
    hasPassword: proxy.password !== "",
    createdAt: proxy.createdAt,
    enabled: proxy.enabled,
    state: stateOf(proxy.enabled, proxy.health),
    accounts,
    health: { ...proxy.health },
  };
}

interface DetectedSource {
  id: string;
  full: string;
  base: string;
  username: string;
  password: string;
  global: boolean;
  accountIds: string[];
}

/** A stable id for a proxy URL, as the server's keyed hash (never the URL itself). */
function detectedId(full: string): string {
  let hash = 2166136261;
  for (const ch of full) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `dx_${hash.toString(16).padStart(8, "0")}${full.length.toString(16).padStart(4, "0")}`;
}

/** The global proxy and accounts' own, grouped by URL: proxypool's detectedProxies. */
function detectedSources(): DetectedSource[] {
  const byUrl = new Map<string, DetectedSource>();
  const add = (raw: string): DetectedSource | undefined => {
    const full = raw.trim();
    if (!full) return undefined;
    const existing = byUrl.get(full);
    if (existing) return existing;
    const parsed = parseUrl(
      /^https?:\/\/[^/]*:\d+/.test(full) || /^socks/.test(full)
        ? full
        : `${full}:${full.startsWith("https") ? 443 : 80}`,
    );
    if ("error" in parsed) return undefined;
    const source: DetectedSource = {
      id: detectedId(full),
      full,
      base: parsed.base,
      username: parsed.user ?? "",
      password: parsed.pass ?? "",
      global: false,
      accountIds: [],
    };
    byUrl.set(full, source);
    return source;
  };
  const global = add(mockDb.proxy.proxyURL);
  if (global) global.global = true;
  for (const account of mockDb.accounts) {
    const source = add(account.proxyURL ?? "");
    if (source) source.accountIds.push(account.id);
  }
  return [...byUrl.values()].sort((a, b) =>
    a.global !== b.global
      ? a.global
        ? -1
        : 1
      : `${a.base}|${a.username}`.localeCompare(`${b.base}|${b.username}`),
  );
}

/** A detected proxy never checked yet gets the full dataset's realistic first result. */
function detectedHealth(source: DetectedSource): PoolProxyHealth {
  const pool = current();
  const known = pool.detected[source.id];
  if (known) return known;
  if (pool.scenario !== "full") return { status: "unknown" };
  const nowMs = mockNowUnix() * 1000;
  return /:1083$|:1087$/.test(source.base)
    ? {
        status: "failed",
        failures: 4,
        checkedAt: nowMs - 4 * 60_000,
        lastError: "connection refused or reset: proxyconnect tcp: connect: connection refused",
        errorCode: "connect",
      }
    : {
        status: "ok",
        checkedAt: nowMs - 4 * 60_000,
        latencyMs: 60 + (source.base.length % 9) * 23,
      };
}

function detectedView(source: DetectedSource): DetectedProxy {
  const signedIn = source.username !== "" || source.password !== "";
  const inPool =
    !signedIn &&
    current().proxies.some((proxy) => proxy.url === source.base && proxy.username === "");
  const health = detectedHealth(source);
  return {
    id: source.id,
    url: source.base,
    ...(source.username ? { username: source.username } : {}),
    hasPassword: source.password !== "",
    global: source.global,
    accountIds: [...source.accountIds],
    inPool,
    canAdopt: !signedIn && !inPool,
    state: detectedStateOf(health),
    health: { ...health },
  };
}

function poolView(): ProxyPoolView {
  const pool = current();
  const proxies = pool.proxies.map(view);
  const detected = detectedSources().map(detectedView);
  const counts: ProxyPoolCounts = { healthy: 0, unhealthy: 0, autoDisabled: 0, off: 0, unknown: 0 };
  for (const item of [...proxies, ...detected]) {
    if (item.state === "healthy") counts.healthy++;
    else if (item.state === "unhealthy") counts.unhealthy++;
    else if (item.state === "auto_disabled") counts.autoDisabled++;
    else if (item.state === "off") counts.off++;
    else counts.unknown++;
  }
  return {
    mode: pool.mode,
    directFallback: pool.directFallback,
    checkIntervalMin: pool.checkIntervalMin,
    maxFailures: MAX_FAILURES,
    proxies,
    detected,
    counts,
    assignments: { ...pool.assignments },
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
        enabled: true,
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
  if (typeof body.enabled === "boolean") next.enabled = body.enabled;
  if ([...next.label].length > MAX_LABEL) return invalid("label must be at most 64 characters");
  if (next.password && !next.username) return invalid("a password needs a username");
  return next;
}

function duplicate(proxy: StoredProxy): boolean {
  return current().proxies.some(
    (other) =>
      other.id !== proxy.id && other.url === proxy.url && other.username === proxy.username,
  );
}

/**
 * A deterministic check (proxypool's applyCheck): an address on port 9 or with "dead" in it
 * fails, others answer. A failure adds a strike; the third in a row marks the proxy failed, and
 * a pass clears them.
 */
function applyCheck(health: PoolProxyHealth, url: string): PoolProxyHealth {
  const now = mockNowUnix() * 1000;
  if (/:9$|dead|:1083$|:1087$|203\.0\.113\.24/.test(url)) {
    const failures = (health.failures ?? 0) + 1;
    const failed = failures >= MAX_FAILURES;
    return {
      status: failed ? "failed" : health.status,
      failures,
      checkedAt: now,
      ...(failed ? { failedAt: health.failedAt ?? now } : {}),
      lastError: "connection refused or reset: proxyconnect tcp: connect: connection refused",
      errorCode: "connect",
    };
  }
  const latencyMs = 80 + ([...url].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 220);
  return { status: "ok", checkedAt: now, latencyMs };
}

function check(proxy: StoredProxy): void {
  const before = proxy.health.status;
  proxy.health = applyCheck(proxy.health, proxy.url);
  if (proxy.health.status === "failed" && before !== "failed") moveAccountsOff(proxy.id);
}

/** proxypool's moveAccountsLocked: accounts on a failed or switched-off proxy go elsewhere. */
function moveAccountsOff(id: string): void {
  const pool = current();
  const rest = pool.proxies.filter(
    (item) => item.id !== id && item.enabled && item.health.status !== "failed",
  );
  let next = 0;
  for (const [account, assigned] of Object.entries(pool.assignments)) {
    if (assigned !== id) continue;
    if (rest.length > 0) pool.assignments[account] = rest[next++ % rest.length].id;
    else delete pool.assignments[account];
  }
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
    if (mode === "on" && current().mode !== "on" && current().proxies.length === 0) {
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
    if (mode !== undefined) current().mode = mode;
    if (typeof body.directFallback === "boolean") current().directFallback = body.directFallback;
    if (typeof interval === "number") current().checkIntervalMin = interval;
    changed();
    return HttpResponse.json(poolView());
  }),

  http.post(apiUrl("/proxy-pool/check"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    for (const proxy of current().proxies) if (proxy.enabled) check(proxy);
    for (const source of detectedSources()) {
      current().detected[source.id] = applyCheck(detectedHealth(source), source.base);
    }
    changed();
    return HttpResponse.json(poolView());
  }),

  http.post(apiUrl("/proxy-pool/proxies"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readObject(request);
    if (!body) return jsonError(400, "Invalid JSON", { code: "invalid_json" });
    if (current().proxies.length >= MAX_PROXIES) {
      return jsonError(400, "the proxy pool is full", { code: "proxy_pool_full" });
    }
    const built = build(body);
    if (built instanceof Response) return built;
    if (duplicate(built)) {
      return jsonError(409, "this proxy is already in the pool", { code: "proxy_pool_duplicate" });
    }
    built.id = `px_mock${current().nextId++}`;
    built.createdAt = mockNowUnix() * 1000;
    current().proxies.push(built);
    changed();
    return HttpResponse.json({ proxy: view(built) }, { status: 201 });
  }),

  http.post(apiUrl("/proxy-pool/proxies/:id/check"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const proxy = current().proxies.find((item) => item.id === params.id);
    if (!proxy) return notFound();
    check(proxy);
    changed();
    return HttpResponse.json({ proxy: view(proxy) });
  }),

  http.put(apiUrl("/proxy-pool/proxies/:id"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const pool = current();
    const index = pool.proxies.findIndex((item) => item.id === params.id);
    if (index < 0) return notFound();
    const body = await readObject(request);
    if (!body) return jsonError(400, "Invalid JSON", { code: "invalid_json" });
    const saved = pool.proxies[index];
    const built = build(body, saved);
    if (built instanceof Response) return built;
    if (duplicate(built)) {
      return jsonError(409, "this proxy is already in the pool", { code: "proxy_pool_duplicate" });
    }
    if (
      built.url !== saved.url ||
      built.username !== saved.username ||
      built.password !== saved.password ||
      (built.enabled && !saved.enabled)
    ) {
      built.health = { status: "unknown" };
    }
    pool.proxies[index] = built;
    if (!built.enabled && saved.enabled) moveAccountsOff(built.id);
    changed();
    return HttpResponse.json({ proxy: view(built) });
  }),

  http.delete(apiUrl("/proxy-pool/proxies/:id"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const index = current().proxies.findIndex((item) => item.id === params.id);
    if (index < 0) return notFound();
    const [removed] = current().proxies.splice(index, 1);
    const rest = current().proxies.filter(
      (item) => item.enabled && item.health.status !== "failed",
    );
    for (const [account, id] of Object.entries(current().assignments)) {
      if (id !== removed.id) continue;
      if (rest.length > 0) current().assignments[account] = rest[0].id;
      else delete current().assignments[account];
    }
    changed();
    return HttpResponse.json({ success: true });
  }),

  http.post(apiUrl("/proxy-pool/detected/:id/check"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const source = detectedSources().find((item) => item.id === params.id);
    if (!source) return notFound();
    current().detected[source.id] = applyCheck(detectedHealth(source), source.base);
    changed();
    return HttpResponse.json({ detected: detectedView(source) });
  }),

  http.post(apiUrl("/proxy-pool/detected/:id/adopt"), async ({ request, params }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const source = detectedSources().find((item) => item.id === params.id);
    if (!source) return notFound();
    if (source.username || source.password) {
      return jsonError(400, "a detected proxy with a sign-in cannot join the pool", {
        code: "proxy_pool_detected_sign_in",
      });
    }
    const pool = current();
    if (pool.proxies.some((item) => item.url === source.base && item.username === "")) {
      return jsonError(409, "this proxy is already in the pool", { code: "proxy_pool_duplicate" });
    }
    if (pool.proxies.length >= MAX_PROXIES) {
      return jsonError(400, "the proxy pool is full", { code: "proxy_pool_full" });
    }
    const added: StoredProxy = {
      id: `px_mock${pool.nextId++}`,
      label: "",
      url: source.base,
      username: "",
      password: "",
      createdAt: mockNowUnix() * 1000,
      enabled: true,
      health: { status: "unknown" },
    };
    pool.proxies.push(added);
    check(added);
    changed();
    return HttpResponse.json({ proxy: view(added) }, { status: 201 });
  }),
];
