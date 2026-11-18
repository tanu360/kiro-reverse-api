import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  ApiKeyUsageBreakdownItem,
  ApiKeyUsageEntry,
  ApiKeyUsageResponse,
  ApiKeyUsageTotals,
} from "@/lib/api/api-key-usage";
import {
  REQUEST_CLIENTS,
  REQUEST_ENDPOINTS,
  type RequestClient,
  type RequestEndpoint,
  type RequestErrorType,
  type RequestRecord,
} from "@/lib/api/types";
import {
  USER_REQUEST_SORTS,
  USER_USAGE_OTHER_CLIENT,
  type UserKey,
  type UserRequest,
  type UserRequestPage,
  type UserRequestSort,
  type UserUsage,
  type UserUsageBreakdown,
  type UserUsageClient,
} from "@/lib/api/user-panel";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import {
  createRng,
  hex,
  int,
  maskKey,
  pick,
  type Rng,
  round,
  uuid,
  weighted,
} from "@/lib/mocks/fixtures";
import { jsonError, mockDelay } from "@/lib/mocks/http";
import { lifetimeGrid } from "@/lib/mocks/lifetime";

// /user/api, as proxy/user_api.go answers it: the API key holder's own panel.
//
// Sign in with the full value of any API key in the mock DB. The deterministic ones:
//   full dataset (the browser default), "Production", near its token and credit limits:
//     sk-6e905b6397eacb0c6f9114936b0d510ceed18d9c2c0fec84e63af0e8e5dd1827
//   small dataset (unit tests, ?mock=small), "team-a":
//     sk-98cfd03d8de6ed9a1c57031c6cb09fdc377e571d02606d8e6c1ba78600c6a6e6
//   both datasets: "kiro-dev-1" (Local dev, no traffic); full only: "demo-key" (Demo, expired).
// Limits, counters, usage and requests are the ones the admin API keys and Requests pages show
// for that key: everything is read from the same mock DB.
//
// Demo keys: one per state of the panel, in every dataset. They live only here, with their own
// request log, so the admin pages never list them. The mock sign-in page lists them too
// (features/user-auth/mock-demo-keys.tsx). Their times count back from when they were built: on
// first use, and again on the first request an hour later. Each has its own mix of callers
// (coding tools, else the API alone); the oldest rows of Web app, Old CI runner, Contractor and
// the heavy key name neither, which usage by client counts as Other.
//   sk-demo-active          "Web app": 30+ days of everyday traffic over six models, about 4% failed
//                           (rate limit, upstream, stream, client closed, timeout, bad request),
//                           cache reads and writes; token and credit limits well under way.
//   sk-demo-near-limit      "Staging": tokens 95%, credits 98% and calls 90% of their limits.
//   sk-demo-over-limit      "Hackathon bot": tokens 104% of the limit, so the proxy turned it off
//                           (config/apikeys.go) and refused 401 since; a few 429s (API key
//                           limit) before, for requests that would have passed the limit.
//   sk-demo-off             "Old CI runner": turned off; refused 401 since the admin did so.
//   sk-demo-expired         "Contractor — Q3": expired three days ago; refused 401 since.
//   sk-demo-expiring        "Trial — Northwind": expires in two days, with a credit limit.
//   sk-demo-restricted      "Mobile app": two allowed models and 30 requests per minute; a few
//                           requests refused 429 by that rate limit.
//   sk-demo-new             No name, created minutes ago, never used: every empty state.
//   sk-demo-heavy           A 112-character name with emoji and CJK, billions of tokens, tens of
//                           thousands of credits, 680 logged requests (7 pages of 100) over 200
//                           days, model names up to 66 characters.
//   sk-demo-usage-busy      Usage and usage by model answer 429 user_usage_busy (Retry-After 60);
//                           the key and its requests load.
//   sk-demo-requests-error  Requests answer 500 internal_error; the key and its usage load.
//   sk-demo-open-server     The server's "Require API key" is off (keysRequired false), for this
//                           key only: the not-counted notice shows.
//   sk-demo-short-session   The session ends 30 s after sign-in: the panel goes back to the
//                           sign-in page, which says the session expired, on its next poll.
// Wrong keys, the empty key and the five-try lockout answer as for any other key.

type StoredKey = (typeof mockDb.apiKeys)[number];

interface UserSession {
  keyId: string;
  /** The key's value at sign-in: a regenerated key ends the session. */
  key: string;
  /** ms epoch */
  expiresAt: number;
}

const SESSION_TTL_MS = (import.meta.env.VITE_MOCK === "1" ? 30 * 24 : 12) * 3600 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** The browser mock keeps its user sessions here, so a reload stays signed in. */
const SESSIONS_KEY = "kiro_mock_user_sessions";

// The user sign-in has its own guess budget, apart from the admin one (core-handlers.ts).
let failedLogins = 0;
let lockedSince = 0;
let sessions = loadSessions();

function persistent(): boolean {
  return import.meta.env.VITE_MOCK === "1";
}

function loadSessions(): Map<string, UserSession> {
  if (!persistent()) return new Map();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "{}");
    return new Map(Object.entries(raw as Record<string, UserSession>));
  } catch {
    return new Map();
  }
}

function saveSessions(): void {
  if (!persistent()) return;
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(Object.fromEntries(sessions)));
  } catch {
    // Storage blocked: sessions last until the page reloads.
  }
}

/** Forgets every user session and wrong guess, and rebuilds the demo keys (tests). */
export function resetUserPanelMock(): void {
  failedLogins = 0;
  lockedSince = 0;
  sessions = new Map();
  demoCache = null;
  saveSessions();
}

// ---------------------------------------------------------------------------
// Demo keys: a key per state of the panel, each with its own request log.
// ---------------------------------------------------------------------------

export type DemoKeyId =
  | "active"
  | "nearLimit"
  | "overLimit"
  | "off"
  | "expired"
  | "expiring"
  | "restricted"
  | "new"
  | "heavy"
  | "usageBusy"
  | "requestsError"
  | "openServer"
  | "shortSession";

/** A demo key as the mock sign-in page lists it. */
export interface DemoKeyInfo {
  id: DemoKeyId;
  /** The value to sign in with. */
  key: string;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
/** The log is rebuilt (times move up to now) on the first request an hour after the last build. */
const DEMO_REBUILD_S = HOUR;
/** Routed requests name an account; the panel never shows it. */
const DEMO_ACCOUNT = "demo-account";

/** How a request fails: what the log keeps, and whether the model was read first. */
interface Failure {
  type: RequestErrorType;
  status: number;
  /** false: refused before the body was read, so the row has no model. */
  routed: boolean;
}

const FAILURES = {
  rateLimit: { type: "rate_limit", status: 429, routed: true },
  upstream: { type: "upstream", status: 500, routed: true },
  stream: { type: "stream", status: 502, routed: true },
  clientClosed: { type: "client_closed", status: 499, routed: true },
  timeout: { type: "timeout", status: 504, routed: true },
  invalidRequest: { type: "invalid_request", status: 400, routed: true },
  // The key's own refusals (proxy/auth.go, apikey_controls.go), before any model is read.
  keyLimit: { type: "api_key_limit", status: 429, routed: false },
  keyRefused: { type: "auth", status: 401, routed: false },
  keyRpm: { type: "rate_limit", status: 429, routed: false },
} satisfies Record<string, Failure>;

type Size = "small" | "medium" | "huge";

/** Log-normal centres and caps of a request's input and output tokens. */
const SIZES: Record<Size, { inMu: number; outMu: number; inMax: number; outMax: number }> = {
  small: { inMu: 7.8, outMu: 5.6, inMax: 40_000, outMax: 4_000 },
  medium: { inMu: 9.4, outMu: 6.6, inMax: 200_000, outMax: 16_000 },
  huge: { inMu: 12.4, outMu: 8.4, inMax: 960_000, outMax: 64_000 },
};

/** What a stretch of traffic looks like. */
interface Mix {
  models: ReadonlyArray<readonly [string, number]>;
  size: Size;
  /** Share of requests that fail, with one of `failures`. */
  failRate: number;
  failures: readonly Failure[];
}

const EVERYDAY_FAILURES: readonly Failure[] = [
  FAILURES.rateLimit,
  FAILURES.upstream,
  FAILURES.stream,
  FAILURES.clientClosed,
  FAILURES.timeout,
  FAILURES.invalidRequest,
];

const TYPICAL: Mix = {
  models: [
    ["claude-sonnet-5", 40],
    ["claude-haiku-4.5", 22],
    ["claude-sonnet-4.6", 14],
    ["claude-opus-5", 12],
    ["auto", 8],
    ["claude-sonnet-5-thinking", 4],
  ],
  size: "medium",
  failRate: 0.04,
  failures: EVERYDAY_FAILURES,
};

const LIGHT: Mix = { ...TYPICAL, size: "small", failRate: 0.02 };

const MOBILE: Mix = {
  models: [
    ["claude-haiku-4.5", 65],
    ["claude-sonnet-5", 35],
  ],
  size: "small",
  failRate: 0.01,
  failures: [FAILURES.stream, FAILURES.clientClosed],
};

const HEAVY: Mix = {
  models: [
    ["claude-sonnet-5", 30],
    ["claude-haiku-4.5", 18],
    ["us.anthropic.claude-opus-4-5-20251101-v1:0", 16],
    ["claude-sonnet-4-5-20250929-thinking-1m-context-extended-output", 14],
    ["claude-opus-5-thinking", 12],
    ["anthropic/claude-3-7-sonnet-20250219:thinking-extended-output-128k", 10],
  ],
  size: "huge",
  failRate: 0.03,
  failures: EVERYDAY_FAILURES,
};

/** Who sent a request: the API it called, and the coding tool if the server knew it. */
interface Caller {
  endpoint: RequestEndpoint;
  client?: RequestClient;
}

const CALLERS = {
  claudeCode: { endpoint: "claude", client: "claude-code" },
  kiloCode: { endpoint: "claude", client: "kilo-code" },
  codex: { endpoint: "responses", client: "codex" },
  opencode: { endpoint: "openai", client: "opencode" },
  cline: { endpoint: "openai", client: "cline" },
  rooCode: { endpoint: "openai", client: "roo-code" },
  // An SDK, a script or a tool the server does not know: the API alone.
  anthropicApi: { endpoint: "claude" },
  openaiApi: { endpoint: "openai" },
  responsesApi: { endpoint: "responses" },
} satisfies Record<string, Caller>;

/** Who calls with a key, by weight. */
type CallerMix = ReadonlyArray<readonly [Caller, number]>;

/** A developer's key: mostly Claude Code, some Codex and opencode, now and then a script. */
const DEVELOPER_CALLERS: CallerMix = [
  [CALLERS.claudeCode, 52],
  [CALLERS.codex, 16],
  [CALLERS.opencode, 10],
  [CALLERS.anthropicApi, 12],
  [CALLERS.openaiApi, 6],
  [CALLERS.cline, 4],
];

interface LogBuilder {
  /** `count` requests at random times between `newest` and `oldest` seconds ago. */
  traffic(count: number, newest: number, oldest: number, mix: Mix): void;
  /** `count` requests refused with `failure`, spread the same way. */
  refused(count: number, newest: number, oldest: number, failure: Failure, mix: Mix): void;
}

/** A stored key's settings; counters left out are the sums of its log. */
type DemoSettings = Partial<Omit<StoredKey, "id" | "key" | "keyMasked">> & { createdAt: number };

interface DemoSpec extends DemoKeyInfo {
  seed: number;
  settings: (now: number) => DemoSettings;
  log?: (log: LogBuilder) => void;
  /** Who calls with the key; a developer's mix by default. */
  callers?: CallerMix;
  /**
   * Requests older than this many seconds were logged before the proxy kept the API and the
   * tool: neither is known, and usage by client counts them as "Other".
   */
  untaggedAfter?: number;
  /** The server's "Require API key" as this key sees it; demo keys default to on. */
  keysRequired?: boolean;
  sessionTtlMs?: number;
  /** /usage and /usage/breakdown answer 429 user_usage_busy. */
  usageBusy?: boolean;
  /** /requests answers 500 internal_error. */
  requestsFail?: boolean;
}

function hourStart(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

function hourEnd(ts: number): number {
  return Math.ceil(ts / HOUR) * HOUR;
}

const DEMO_SPECS: readonly DemoSpec[] = [
  {
    id: "active",
    key: "sk-demo-active",
    seed: 7101,
    settings: (now) => ({
      name: "Web app",
      createdAt: now - 45 * DAY,
      tokenLimit: 50_000_000,
      creditLimit: 1_500,
    }),
    // The app's backend calls through the SDKs; its developers use their coding tools.
    callers: [
      [CALLERS.anthropicApi, 38],
      [CALLERS.claudeCode, 24],
      [CALLERS.openaiApi, 14],
      [CALLERS.codex, 10],
      [CALLERS.opencode, 8],
      [CALLERS.responsesApi, 6],
    ],
    untaggedAfter: 38 * DAY,
    log: (log) => {
      log.traffic(42, 2 * MINUTE, DAY, TYPICAL);
      log.traffic(140, DAY, 7 * DAY, TYPICAL);
      log.traffic(210, 7 * DAY, 30 * DAY, TYPICAL);
      log.traffic(60, 30 * DAY, 45 * DAY, TYPICAL);
    },
  },
  {
    id: "nearLimit",
    key: "sk-demo-near-limit",
    seed: 7102,
    settings: (now) => ({
      name: "Staging",
      createdAt: now - 21 * DAY,
      tokenLimit: 2_000_000,
      tokensUsed: 1_903_640,
      creditLimit: 40,
      creditsUsed: 39.27,
      callLimit: 500,
      successfulCalls: 451,
      requestsCount: 468,
    }),
    callers: [
      [CALLERS.claudeCode, 40],
      [CALLERS.anthropicApi, 26],
      [CALLERS.rooCode, 18],
      [CALLERS.openaiApi, 16],
    ],
    log: (log) => {
      log.traffic(18, 4 * MINUTE, DAY, LIGHT);
      log.traffic(70, DAY, 7 * DAY, LIGHT);
      log.traffic(110, 7 * DAY, 21 * DAY, LIGHT);
    },
  },
  {
    id: "overLimit",
    key: "sk-demo-over-limit",
    seed: 7103,
    settings: (now) => ({
      name: "Hackathon bot",
      // A reached token or credit limit turns the key off, as on the real server.
      enabled: false,
      createdAt: now - 12 * DAY,
      tokenLimit: 1_000_000,
      tokensUsed: 1_041_377,
      requestsCount: 171,
      successfulCalls: 158,
    }),
    callers: [
      [CALLERS.openaiApi, 44],
      [CALLERS.claudeCode, 22],
      [CALLERS.kiloCode, 18],
      [CALLERS.anthropicApi, 16],
    ],
    log: (log) => {
      // Turned off since its last success: "API key disabled" (401). Near the limit, the token
      // reservation refused the requests that would have passed it (429) and let smaller ones by.
      log.refused(6, 2 * MINUTE, 2 * HOUR, FAILURES.keyRefused, LIGHT);
      log.refused(3, 2 * HOUR, 5 * HOUR, FAILURES.keyLimit, LIGHT);
      log.traffic(150, 2 * HOUR, 12 * DAY, LIGHT);
    },
  },
  {
    id: "off",
    key: "sk-demo-off",
    seed: 7104,
    settings: (now) => ({ name: "Old CI runner", enabled: false, createdAt: now - 60 * DAY }),
    // Headless Claude Code in the pipeline, and a review script on the SDK.
    callers: [
      [CALLERS.claudeCode, 64],
      [CALLERS.anthropicApi, 36],
    ],
    untaggedAfter: 32 * DAY,
    log: (log) => {
      log.refused(7, 6 * MINUTE, 2 * DAY, FAILURES.keyRefused, LIGHT);
      log.traffic(120, 2 * DAY, 40 * DAY, LIGHT);
    },
  },
  {
    id: "expired",
    key: "sk-demo-expired",
    seed: 7105,
    settings: (now) => ({
      name: "Contractor — Q3",
      createdAt: now - 95 * DAY,
      expiresAt: hourStart(now - 3 * DAY),
      creditLimit: 200,
    }),
    callers: [
      [CALLERS.codex, 34],
      [CALLERS.claudeCode, 30],
      [CALLERS.cline, 16],
      [CALLERS.anthropicApi, 12],
      [CALLERS.responsesApi, 8],
    ],
    untaggedAfter: 60 * DAY,
    log: (log) => {
      // The expiry is on the hour three days ago: refusals after it, traffic before.
      log.refused(5, 12 * MINUTE, 3 * DAY - HOUR, FAILURES.keyRefused, LIGHT);
      log.traffic(160, 3 * DAY + HOUR, 90 * DAY, TYPICAL);
    },
  },
  {
    id: "expiring",
    key: "sk-demo-expiring",
    seed: 7106,
    settings: (now) => ({
      name: "Trial — Northwind",
      createdAt: now - 12 * DAY,
      expiresAt: hourEnd(now + 2 * DAY),
      creditLimit: 25,
    }),
    callers: [
      [CALLERS.kiloCode, 34],
      [CALLERS.claudeCode, 28],
      [CALLERS.rooCode, 20],
      [CALLERS.openaiApi, 18],
    ],
    log: (log) => log.traffic(110, 8 * MINUTE, 12 * DAY, LIGHT),
  },
  {
    id: "restricted",
    key: "sk-demo-restricted",
    seed: 7107,
    settings: (now) => ({
      name: "Mobile app",
      createdAt: now - 30 * DAY,
      allowedModels: ["claude-haiku-4.5", "claude-sonnet-5"],
      rpmLimit: 30,
    }),
    // The app's backend on the Anthropic SDK; its team tries things in Claude Code.
    callers: [
      [CALLERS.anthropicApi, 66],
      [CALLERS.openaiApi, 18],
      [CALLERS.claudeCode, 16],
    ],
    log: (log) => {
      log.traffic(260, MINUTE, 30 * DAY, MOBILE);
      log.refused(8, 10 * MINUTE, 5 * DAY, FAILURES.keyRpm, MOBILE);
    },
  },
  {
    id: "new",
    key: "sk-demo-new",
    seed: 7108,
    settings: (now) => ({ createdAt: now - 12 * MINUTE }),
  },
  {
    id: "heavy",
    key: "sk-demo-heavy",
    seed: 7109,
    settings: (now) => ({
      name: "Nightly evaluation fleet 🚀 — 東京 & São Paulo batch runners, shared by research, platform and data (do not delete)",
      createdAt: now - 410 * DAY,
      tokenLimit: 5_000_000_000,
      tokensUsed: 2_948_120_553,
      creditLimit: 100_000,
      creditsUsed: 48_211.37,
      callLimit: 2_000_000,
      successfulCalls: 1_271_904,
      requestsCount: 1_284_551,
      rpmLimit: 600,
    }),
    // Every tool and API the evaluations cover, and rows from before the proxy kept them.
    callers: [
      [CALLERS.anthropicApi, 24],
      [CALLERS.claudeCode, 18],
      [CALLERS.responsesApi, 14],
      [CALLERS.codex, 12],
      [CALLERS.openaiApi, 10],
      [CALLERS.opencode, 8],
      [CALLERS.kiloCode, 6],
      [CALLERS.cline, 4],
      [CALLERS.rooCode, 4],
    ],
    untaggedAfter: 120 * DAY,
    log: (log) => {
      log.traffic(30, 5, HOUR, HEAVY);
      log.traffic(150, HOUR, DAY, HEAVY);
      log.traffic(220, DAY, 7 * DAY, HEAVY);
      log.traffic(160, 7 * DAY, 30 * DAY, HEAVY);
      log.traffic(120, 30 * DAY, 200 * DAY, HEAVY);
    },
  },
  {
    id: "usageBusy",
    key: "sk-demo-usage-busy",
    seed: 7110,
    usageBusy: true,
    settings: (now) => ({
      name: "Shared notebook",
      createdAt: now - 20 * DAY,
      tokenLimit: 10_000_000,
    }),
    callers: [
      [CALLERS.anthropicApi, 46],
      [CALLERS.openaiApi, 30],
      [CALLERS.claudeCode, 24],
    ],
    log: (log) => log.traffic(90, 3 * MINUTE, 20 * DAY, TYPICAL),
  },
  {
    id: "requestsError",
    key: "sk-demo-requests-error",
    seed: 7111,
    requestsFail: true,
    settings: (now) => ({ name: "Reporting job", createdAt: now - 15 * DAY, creditLimit: 300 }),
    callers: [
      [CALLERS.anthropicApi, 56],
      [CALLERS.openaiApi, 26],
      [CALLERS.claudeCode, 18],
    ],
    log: (log) => log.traffic(80, 9 * MINUTE, 15 * DAY, TYPICAL),
  },
  {
    id: "openServer",
    key: "sk-demo-open-server",
    seed: 7112,
    keysRequired: false,
    settings: (now) => ({ name: "LAN tools", createdAt: now - 25 * DAY }),
    callers: [
      [CALLERS.opencode, 30],
      [CALLERS.cline, 22],
      [CALLERS.rooCode, 18],
      [CALLERS.claudeCode, 16],
      [CALLERS.openaiApi, 14],
    ],
    log: (log) => log.traffic(70, 15 * MINUTE, 25 * DAY, LIGHT),
  },
  {
    id: "shortSession",
    key: "sk-demo-short-session",
    seed: 7113,
    sessionTtlMs: 30_000,
    settings: (now) => ({ name: "Kiosk", createdAt: now - 8 * DAY }),
    callers: [
      [CALLERS.claudeCode, 50],
      [CALLERS.anthropicApi, 50],
    ],
    log: (log) => log.traffic(40, 20 * MINUTE, 8 * DAY, LIGHT),
  },
];

/** Every demo key, in the order the mock sign-in page lists them. */
export const DEMO_KEYS: readonly DemoKeyInfo[] = DEMO_SPECS.map(({ id, key }) => ({ id, key }));

/** Log-normal draw clamped to [min, max]. */
function logNormal(rng: Rng, mu: number, sigma: number, min: number, max: number): number {
  const u = Math.max(rng(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  return Math.min(max, Math.max(min, Math.round(Math.exp(mu + sigma * z))));
}

function modelRate(model: string): number {
  if (model.includes("opus")) return 2.2;
  if (model.includes("haiku")) return 0.4;
  if (model.includes("sonnet-5")) return 1.3;
  return 1;
}

/**
 * Milliseconds per output token once a reply streams, before a ±30% spread: Haiku about 125
 * tokens a second, Opus about 40 and the rest (Sonnet, auto) about 70, as Claude writes them.
 */
function msPerOutputToken(model: string): number {
  if (model.includes("haiku")) return 8;
  if (model.includes("opus")) return 25;
  return 14;
}

/**
 * Extra draws for one row, seeded from text of its own (its request ID), so the log's seeded
 * draws stay as they were.
 */
function sideRng(text: string): Rng {
  let seed = 2166136261;
  for (const char of text) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return createRng(seed);
}

/** Upstream attempts of a request that succeeded: 90% first time, the rest after a failover. */
function successTries(rng: Rng): number {
  const roll = rng();
  if (roll < 0.03) return 3;
  return roll < 0.1 ? 2 : 1;
}

/**
 * Attempts before a routed failure: a rate limit fails over across the accounts, a server error
 * is tried again, a bad request or a client that left is not.
 */
function failureTries(rng: Rng, type: RequestErrorType | undefined): number {
  switch (type) {
    case "rate_limit":
      return int(rng, 2, 5);
    case "upstream":
      return int(rng, 2, 3);
    case "stream":
    case "timeout":
      return int(rng, 1, 2);
    default:
      return 1;
  }
}

/** The full dataset's credit formula (fixtures-full.ts): cache reads cost a tenth. */
function credits(model: string, inTokens: number, outTokens: number, read = 0, write = 0): number {
  const value =
    ((inTokens - read * 0.9 + write * 0.25) / 100_000 + outTokens / 20_000) * modelRate(model);
  return Math.max(0.0001, round(value, 4));
}

function demoRecord(
  rng: Rng,
  key: Pick<StoredKey, "id" | "keyMasked">,
  ts: number,
  mix: Mix,
  failure: Failure | null,
  callers: CallerMix,
  untagged: boolean,
): RequestRecord {
  const model = weighted(rng, mix.models);
  const size = SIZES[mix.size];
  // One draw, as the endpoint alone took, so the seeded draws after it stay as they were.
  const caller = weighted(rng, callers);
  const base = {
    ts,
    apiKeyId: key.id,
    apiKeyMasked: key.keyMasked,
    ...(untagged ? {} : { endpoint: caller.endpoint, client: caller.client }),
    requestId: `req_${hex(rng, 24)}`,
  };
  // How many upstream attempts it took: none for a request the key refused before routing.
  const side = sideRng(base.requestId);
  if (failure) {
    // A cut stream or a client that left mid-answer is billed for what it got.
    const partial = failure.type === "stream" || failure.type === "client_closed";
    const inTokens = partial ? logNormal(rng, size.inMu, 0.8, 1, size.inMax) : 0;
    const outTokens = partial ? logNormal(rng, size.outMu - 1, 0.8, 1, size.outMax) : 0;
    return {
      ...base,
      accountId: failure.routed ? DEMO_ACCOUNT : "",
      model: failure.routed ? model : "",
      inTokens,
      outTokens,
      totalTokens: inTokens + outTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      credits: partial ? credits(model, inTokens, outTokens) : 0,
      success: false,
      status: failure.status,
      errorType: failure.type,
      durationMs: failure.routed ? int(rng, 900, 45_000) : int(rng, 1, 40),
      tries: failure.routed ? failureTries(side, failure.type) : 0,
    };
  }
  const tries = successTries(side);
  const inTokens = logNormal(rng, size.inMu, 1, 200, size.inMax);
  const outTokens = logNormal(rng, size.outMu, 0.9, 12, size.outMax);
  // Cache reads and writes are part of the input.
  const cacheReadTokens = rng() < 0.55 ? Math.floor(inTokens * (0.3 + rng() * 0.6)) : 0;
  const cacheWriteTokens =
    rng() < 0.2 ? Math.floor((inTokens - cacheReadTokens) * (0.2 + rng() * 0.6)) : 0;
  return {
    ...base,
    accountId: DEMO_ACCOUNT,
    model,
    inTokens,
    outTokens,
    totalTokens: inTokens + outTokens,
    cacheReadTokens,
    cacheWriteTokens,
    credits: credits(model, inTokens, outTokens, cacheReadTokens, cacheWriteTokens),
    success: true,
    status: 200,
    // Time to first token, then the model's output speed, plus a wait for each extra try.
    durationMs: Math.round(
      400 +
        rng() * 1100 +
        outTokens * msPerOutputToken(model) * (0.7 + rng() * 0.6) +
        (tries - 1) * int(side, 800, 6_000),
    ),
    tries,
  };
}

interface DemoKey {
  spec: DemoSpec;
  key: StoredKey;
  /** Newest first, like the mock DB's log. */
  records: RequestRecord[];
}

function isUntagged(spec: DemoSpec, now: number, ts: number): boolean {
  return spec.untaggedAfter !== undefined && ts < now - spec.untaggedAfter;
}

function buildDemoKey(spec: DemoSpec, now: number): DemoKey {
  const rng = createRng(spec.seed);
  const id = uuid(rng);
  const keyMasked = maskKey(spec.key);
  const records: RequestRecord[] = [];
  const at = (newest: number, oldest: number) =>
    now - newest - Math.floor(rng() * Math.max(1, oldest - newest));
  const callers = spec.callers ?? DEVELOPER_CALLERS;
  const record = (ts: number, mix: Mix, failure: Failure | null) =>
    demoRecord(rng, { id, keyMasked }, ts, mix, failure, callers, isUntagged(spec, now, ts));
  spec.log?.({
    traffic(count, newest, oldest, mix) {
      for (let i = 0; i < count; i++) {
        const failure = rng() < mix.failRate ? pick(rng, mix.failures) : null;
        records.push(record(at(newest, oldest), mix, failure));
      }
    },
    refused(count, newest, oldest, failure, mix) {
      for (let i = 0; i < count; i++) {
        records.push(record(at(newest, oldest), mix, failure));
      }
    },
  });
  records.sort((a, b) => b.ts - a.ts);
  // Persisted ids, oldest first.
  for (const [index, record] of records.entries()) record.id = records.length - index;
  const succeeded = records.filter((record) => record.success);
  const settings = spec.settings(now);
  const key: StoredKey = {
    id,
    key: spec.key,
    keyMasked,
    enabled: true,
    tokensUsed: records.reduce((sum, record) => sum + record.totalTokens, 0),
    creditsUsed: round(
      records.reduce((sum, record) => sum + record.credits, 0),
      4,
    ),
    requestsCount: records.length,
    successfulCalls: succeeded.length,
    ...(succeeded[0] ? { lastUsedAt: succeeded[0].ts } : {}),
    ...settings,
  };
  return { spec, key, records };
}

let demoCache: { builtAt: number; byValue: Map<string, DemoKey> } | null = null;

/** The demo keys by value, built on first use and again an hour later. */
function demoKeys(): Map<string, DemoKey> {
  const now = mockNowUnix();
  if (!demoCache || now - demoCache.builtAt >= DEMO_REBUILD_S) {
    demoCache = {
      builtAt: now,
      byValue: new Map(DEMO_SPECS.map((spec) => [spec.key, buildDemoKey(spec, now)])),
    };
  }
  return demoCache.byValue;
}

function demoKeyById(id: string): DemoKey | undefined {
  for (const demo of demoKeys().values()) if (demo.key.id === id) return demo;
  return undefined;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** The signed-in key and the log its routes read: the mock DB's, or a demo key's own. */
interface Holder {
  key: StoredKey;
  log: readonly RequestRecord[];
  keysRequired: boolean;
  demo?: DemoSpec;
}

function holderFor(keyId: string): Holder | undefined {
  const stored = mockDb.apiKeys.find((k) => k.id === keyId);
  if (stored) {
    return { key: stored, log: mockDb.requests, keysRequired: mockDb.settings.requireApiKey };
  }
  const demo = demoKeyById(keyId);
  if (!demo) return undefined;
  return {
    key: demo.key,
    log: demo.records,
    keysRequired: demo.spec.keysRequired ?? true,
    demo: demo.spec,
  };
}

/** '/user/api' + path (USER_API_BASE, not imported so the mocks stay free of the query client). */
function userUrl(path: string): string {
  return `/user/api${path}`;
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/** A 429 with Retry-After while the guess budget is spent, as the admin sign-in answers it. */
function guessLimited(): Response | null {
  if (failedLogins < LOGIN_FAILURE_LIMIT) return null;
  const left = lockedSince + LOGIN_LOCK_MS - Date.now();
  if (left > 0) {
    return jsonError(429, "Too many API key attempts; try again later", undefined, {
      "Retry-After": String(Math.max(1, Math.ceil(left / 1000))),
    });
  }
  failedLogins = 0;
  return null;
}

function wrongGuess(): void {
  failedLogins += 1;
  if (failedLogins >= LOGIN_FAILURE_LIMIT) lockedSince = Date.now();
}

function sessionExpired(): Response {
  return jsonError(401, "Unauthorized", { code: "user_session_expired" });
}

/**
 * The key behind X-User-Token, or a 401 for a missing, unknown or expired token, a deleted key
 * or a key whose value changed since the sign-in.
 */
function requireUser(request: Request): { holder: Holder } | { denied: Response } {
  const token = request.headers.get("X-User-Token") ?? "";
  const session = token ? sessions.get(token) : undefined;
  const holder = session ? holderFor(session.keyId) : undefined;
  if (!session || !holder || holder.key.key !== session.key || Date.now() >= session.expiresAt) {
    if (session) {
      sessions.delete(token);
      saveSessions();
    }
    return { denied: sessionExpired() };
  }
  return { holder };
}

/** The admin apiKeyView's fields a holder may see; zeros and [] instead of omitted fields. */
function keyView({ key: stored, keysRequired }: Holder): UserKey {
  const expiresAt = stored.expiresAt ?? 0;
  return {
    id: stored.id,
    name: stored.name ?? "",
    keyMasked: stored.keyMasked,
    enabled: stored.enabled,
    expired: expiresAt > 0 && expiresAt <= mockNowUnix(),
    createdAt: stored.createdAt,
    lastUsedAt: stored.lastUsedAt ?? 0,
    expiresAt,
    tokenLimit: stored.tokenLimit ?? 0,
    tokensUsed: stored.tokensUsed,
    creditLimit: stored.creditLimit ?? 0,
    creditsUsed: stored.creditsUsed,
    callLimit: stored.callLimit ?? 0,
    successfulCalls: stored.successfulCalls ?? 0,
    requestsCount: stored.requestsCount,
    rpmLimit: stored.rpmLimit ?? 0,
    allowedModels: [...(stored.allowedModels ?? [])],
    keysRequired,
  };
}

// ---------------------------------------------------------------------------
// Usage: the admin usage mock (features/api/mocks.ts) for this key's records only.
// ---------------------------------------------------------------------------

const USAGE_RANGES: Record<string, { bucket: "hour" | "day"; seconds: number; count: number }> = {
  "24h": { bucket: "hour", seconds: 3600, count: 24 },
  "7d": { bucket: "day", seconds: 86400, count: 7 },
  "30d": { bucket: "day", seconds: 86400, count: 30 },
};

/** The range and tzOffset parameters, validated like the admin usage route. */
function usageParams(request: Request): { range: string; tzOffset: number } | { error: Response } {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "24h";
  if (!USAGE_RANGES[range] && range !== "all") {
    return {
      error: jsonError(400, "range must be 24h, 7d, 30d or all", { code: "invalid_usage_range" }),
    };
  }
  const tzRaw = url.searchParams.get("tzOffset") || "0";
  const tzOffset = Number(tzRaw);
  if (!/^-?\d+$/.test(tzRaw) || Math.abs(tzOffset) > 840) {
    return {
      error: jsonError(400, "tzOffset must be whole minutes between -840 and 840", {
        code: "invalid_tz_offset",
      }),
    };
  }
  return { range, tzOffset };
}

/** A key over its usage queries for the minute, as proxy/user_api.go answers it. */
function usageBusy(): Response {
  return jsonError(
    429,
    "Too many usage requests; try again in a minute",
    { code: "user_usage_busy" },
    { "Retry-After": "60" },
  );
}

function zeroUsage(): ApiKeyUsageTotals {
  return { requests: 0, succeeded: 0, failed: 0, inTokens: 0, outTokens: 0, tokens: 0, credits: 0 };
}

function addUsage(totals: ApiKeyUsageTotals, record: RequestRecord): void {
  totals.requests += 1;
  if (record.success) totals.succeeded += 1;
  else totals.failed += 1;
  totals.inTokens += record.inTokens;
  totals.outTokens += record.outTokens;
  totals.tokens += record.inTokens + record.outTokens;
  totals.credits += record.credits;
}

/**
 * The admin usage response with only this key in `keys` (absent when it has no traffic in the
 * range, as there). The grid is the admin one: All time starts at the log's oldest record.
 */
function buildUsage({ key, log }: Holder, range: string, tzOffset: number): UserUsage {
  const nowUnix = mockNowUnix();
  const spec = USAGE_RANGES[range];
  const off = tzOffset * 60;
  const oldest = log.reduce<number | undefined>(
    (min, record) => (min === undefined || record.ts < min ? record.ts : min),
    undefined,
  );
  const grid = spec ? undefined : lifetimeGrid(oldest, nowUnix, tzOffset);
  const seconds = spec?.seconds ?? 86400;
  const current = Math.floor((nowUnix + off) / seconds);
  const first = current - (spec?.count ?? 1) + 1;
  const from = grid?.from ?? first * seconds - off;
  const to = grid?.to ?? (current + 1) * seconds - off;
  const buckets =
    grid?.buckets ?? Array.from({ length: spec?.count ?? 0 }, (_, i) => from + i * seconds);
  const entry: ApiKeyUsageEntry = {
    id: key.id,
    kind: "key",
    ...(key.name ? { name: key.name } : {}),
    keyMasked: key.keyMasked,
    totals: zeroUsage(),
    series: Array.from({ length: buckets.length }, zeroUsage),
  };
  for (const record of log) {
    if (record.apiKeyId !== key.id || record.ts < from || record.ts >= to) continue;
    const index = grid ? grid.index(record.ts) : Math.floor((record.ts + off) / seconds) - first;
    if (index < 0) continue;
    addUsage(entry.totals, record);
    addUsage(entry.series[index], record);
  }
  // The stretch before the range, as long as the part of it that has passed (user_api.go's
  // userUsagePrevious); the lifetime has none.
  let previous: ApiKeyUsageTotals | undefined;
  if (spec) {
    const span = spec.seconds * spec.count;
    const before = zeroUsage();
    for (const record of log) {
      if (record.apiKeyId !== key.id || record.ts < from - span || record.ts > nowUnix - span) {
        continue;
      }
      addUsage(before, record);
    }
    previous = before;
  }
  return {
    range: range as ApiKeyUsageResponse["range"],
    bucket: grid?.bucket ?? spec?.bucket ?? "day",
    bucketSeconds: grid?.bucketSeconds ?? seconds,
    tzOffset,
    from,
    to,
    nowUnix,
    buckets,
    // As the server: the key's own entry always, with zeros when it has no traffic.
    totals: { ...entry.totals },
    keys: [entry],
    ...(previous ? { previous } : {}),
  };
}

/**
 * Who sent a request, as proxy/apikey_usage_breakdown.go usageClient names it: the coding tool,
 * else the API, else "other".
 */
function usageClient(record: RequestRecord): UserUsageClient {
  if (isClient(record.client)) return record.client;
  return REQUEST_ENDPOINTS.find((known) => known === record.endpoint) ?? USER_USAGE_OTHER_CLIENT;
}

function busiestFirst<T extends ApiKeyUsageBreakdownItem>(items: Iterable<T>): T[] {
  return [...items].sort(
    (a, b) => b.requests - a.requests || b.credits - a.credits || a.id.localeCompare(b.id),
  );
}

/** Adds one request to its row of a breakdown, `item` being that row while it has none. */
function addToBreakdown<T extends ApiKeyUsageBreakdownItem>(
  sums: Map<string, T>,
  item: T,
  record: RequestRecord,
): void {
  const sum = sums.get(item.id) ?? item;
  sum.requests += 1;
  if (record.success) sum.succeeded += 1;
  else sum.failed += 1;
  sum.tokens += record.totalTokens;
  sum.credits += record.credits;
  sums.set(item.id, sum);
}

/** The admin breakdown for ref key:<id> by model, and by client; never by account. */
function buildBreakdown(holder: Holder, range: string, tzOffset: number): UserUsageBreakdown {
  const { key, log } = holder;
  const usage = buildUsage(holder, range, tzOffset);
  const models = new Map<string, ApiKeyUsageBreakdownItem>();
  const clients = new Map<string, UserUsageBreakdown["clients"][number]>();
  const zero = { requests: 0, succeeded: 0, failed: 0, tokens: 0, credits: 0 };
  for (const record of log) {
    if (record.apiKeyId !== key.id || record.ts < usage.from || record.ts >= usage.to) continue;
    addToBreakdown(models, { id: record.model, ...zero }, record);
    addToBreakdown(clients, { id: usageClient(record), ...zero }, record);
  }
  return {
    ref: `key:${key.id}`,
    range: usage.range,
    from: usage.from,
    to: usage.to,
    models: busiestFirst(models.values()),
    accounts: [],
    clients: busiestFirst(clients.values()),
  };
}

// ---------------------------------------------------------------------------
// Requests: this key's rows of the mock request log, as the admin Requests page lists them.
// ---------------------------------------------------------------------------

/** The mock log carries no request IDs: a stable one per row, like "req_" + 24 hex. */
function requestIdFor(record: RequestRecord): string {
  return `req_${hex(sideRng(`${record.id ?? 0}:${record.ts}:${record.apiKeyId ?? ""}`), 24)}`;
}

/**
 * The upstream attempts a row took, as the server counts them (proxy/request_attempts.go
 * attemptCount): a demo row's own count, else its chain plus the attempts the cap dropped, else
 * (the mock DB keeps no chain) a draw seeded from the row; none for a request refused before
 * routing.
 */
function recordTries(record: RequestRecord): number {
  if (record.tries !== undefined) return record.tries;
  const attempts = record.attempts ?? [];
  if (attempts.length > 0) return attempts.length + (attempts.at(-1)?.skipped ?? 0);
  if (!record.accountId) return 0;
  const rng = sideRng(`tries:${record.requestId ?? requestIdFor(record)}`);
  return record.success ? successTries(rng) : failureTries(rng, record.errorType);
}

function isClient(value: string | undefined): value is RequestClient {
  return (REQUEST_CLIENTS as readonly (string | undefined)[]).includes(value);
}

/**
 * Only the fields a key holder may see: no account, email, message or body, and of the attempts
 * only their count.
 */
function requestView(record: RequestRecord): UserRequest {
  return {
    ts: record.ts,
    model: record.model,
    endpoint: record.endpoint ?? "",
    client: isClient(record.client) ? record.client : "",
    inTokens: record.inTokens,
    outTokens: record.outTokens,
    totalTokens: record.totalTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    credits: record.credits,
    success: record.success,
    status: record.status ?? (record.success ? 200 : 500),
    durationMs: record.durationMs ?? 0,
    errorType: record.success ? "" : (record.errorType ?? "unknown"),
    requestId: record.requestId ?? requestIdFor(record),
    tries: recordTries(record),
  };
}

function positiveInt(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

function sign(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The persisted ORDER BY of each sort a holder may use (proxy/observe_persist.go). */
function primaryCompare(a: RequestRecord, b: RequestRecord, sort: UserRequestSort): number {
  switch (sort) {
    case "status":
      return sign(Number(a.success), Number(b.success));
    case "model":
      return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    case "tokens":
      return sign(a.totalTokens, b.totalTokens);
    case "credits":
      return sign(a.credits, b.credits);
    case "duration":
      return sign(a.durationMs ?? 0, b.durationMs ?? 0);
    default:
      return sign(a.ts, b.ts);
  }
}

/**
 * This key's rows of one status tab, sorted (an account or unknown sort is time, as the server
 * has it), with the key's count per tab.
 */
function listRequests({ key, log }: Holder, url: URL): UserRequestPage {
  const q = url.searchParams;
  const page = positiveInt(q.get("page"), 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, positiveInt(q.get("pageSize"), PAGE_SIZE));
  const status = q.get("status") ?? "all";
  const rawSort = (q.get("sort") ?? "").trim().toLowerCase();
  const sort = (USER_REQUEST_SORTS as readonly string[]).includes(rawSort)
    ? (rawSort as UserRequestSort)
    : "time";
  const order = (q.get("order") ?? "").trim().toLowerCase() === "asc" ? "asc" : "desc";
  const direction = order === "asc" ? 1 : -1;
  const mine = log.filter((record) => record.apiKeyId === key.id);
  const succeeded = mine.filter((record) => record.success).length;
  const rows = mine
    .filter((record) =>
      status === "success" ? record.success : status === "error" ? !record.success : true,
    )
    .sort((a, b) => direction * (primaryCompare(a, b, sort) || sign(a.id ?? 0, b.id ?? 0)));
  const start = (page - 1) * pageSize;
  return {
    requests: rows.slice(start, start + pageSize).map(requestView),
    total: rows.length,
    page,
    pageSize,
    sort,
    order,
    counts: { all: mine.length, succeeded, failed: mine.length - succeeded },
  };
}

async function readKey(request: Request): Promise<string> {
  const body: unknown = await request.json().catch(() => null);
  const key = typeof body === "object" && body !== null ? (body as { key?: unknown }).key : "";
  return typeof key === "string" ? key.trim() : "";
}

export const handlers: HttpHandler[] = [
  http.post(userUrl("/session"), async ({ request }) => {
    await mockDelay();
    const limited = guessLimited();
    if (limited) return limited;
    const value = await readKey(request);
    if (!value) return jsonError(400, "API key is required", { code: "user_key_required" });
    const demo = demoKeys().get(value);
    const key = mockDb.apiKeys.find((k) => k.key === value) ?? demo?.key;
    if (!key) {
      wrongGuess();
      return jsonError(401, "Invalid API key", { code: "user_key_invalid" });
    }
    failedLogins = 0;
    const token = randomHex(64);
    const expiresAt = Date.now() + (demo?.spec.sessionTtlMs ?? SESSION_TTL_MS);
    sessions.set(token, { keyId: key.id, key: key.key, expiresAt });
    saveSessions();
    return HttpResponse.json({ token, expiresAt: Math.floor(expiresAt / 1000) });
  }),

  http.delete(userUrl("/session"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    sessions.delete(request.headers.get("X-User-Token") ?? "");
    saveSessions();
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(userUrl("/key"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    return HttpResponse.json(keyView(user.holder));
  }),

  http.get(userUrl("/usage/breakdown"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    const params = usageParams(request);
    if ("error" in params) return params.error;
    if (user.holder.demo?.usageBusy) return usageBusy();
    return HttpResponse.json(buildBreakdown(user.holder, params.range, params.tzOffset));
  }),

  http.get(userUrl("/usage"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    const params = usageParams(request);
    if ("error" in params) return params.error;
    if (user.holder.demo?.usageBusy) return usageBusy();
    return HttpResponse.json(buildUsage(user.holder, params.range, params.tzOffset));
  }),

  http.get(userUrl("/requests"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    if (user.holder.demo?.requestsFail) {
      return jsonError(500, "Internal error", { code: "internal_error" });
    }
    return HttpResponse.json(listRequests(user.holder, new URL(request.url)));
  }),
];
