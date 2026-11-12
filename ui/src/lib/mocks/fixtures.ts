import type {
  Account,
  AccountFull,
  AccountProfile,
  ApiKey,
  BackupEntry,
  EndpointConfig,
  ExportAccount,
  ExportData,
  HeatmapCell,
  HeatmapData,
  ModelInfo,
  ModelMappingRule,
  ModelMixEntry,
  ObserveError,
  ObserveOverview,
  OverageResponse,
  PromptFilterConfig,
  RequestEndpoint,
  RequestErrorType,
  RequestRecord,
  Settings,
  StatusResponse,
  TestAccountResponse,
  ThinkingConfig,
} from "@/lib/api/types";
import type { MockDb } from "./db";

// Seeded fixture factories for mock mode and tests. Every seed function draws from its own
// fixed-seed PRNG, so the data is the same on every load (stable screenshots); timestamps are
// relative to "now".

const HOUR = 3600;
const DAY = 86_400;

/** Seeded PRNG (mulberry32): the same seed always gives the same sequence in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

// Factories called at runtime (handlers creating new rows) share one stream.
const factoryRng = createRng(0x5eed);

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export function weighted<T>(rng: Rng, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1][0];
}

export function hex(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += Math.floor(rng() * 16).toString(16);
  return out;
}

export function base64ish(rng: Rng, length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

export function uuid(rng: Rng): string {
  const h = hex(rng, 32).split("");
  h[12] = "4";
  h[16] = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** FNV-1a, to derive a stable seed from an id. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function nextResetDate(): string {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-01`;
}

export function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 6)}****${key.slice(-4)}` : key;
}

function isApiKeyAccount(account: Pick<Account, "authMethod">): boolean {
  return account.authMethod === "api_key" || account.authMethod === "apikey";
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const MODEL_CATALOG: ReadonlyArray<{ id: string; name: string; rate: number }> = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", rate: 1.3 },
  { id: "claude-opus-5", name: "Claude Opus 5", rate: 2.2 },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", rate: 0.4 },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", rate: 1 },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", rate: 1 },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6", rate: 2.2 },
];

const MODEL_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ["claude-sonnet-5", 34],
  ["claude-opus-5", 14],
  ["claude-haiku-4.5", 22],
  ["claude-sonnet-4.6", 14],
  ["claude-sonnet-4.5", 9],
  ["claude-opus-4.6", 7],
];

function modelRate(model: string): number {
  return MODEL_CATALOG.find((m) => m.id === model)?.rate ?? 1;
}

/** A model from the catalog; `modelId` picks the entry, other overrides win. */
export function makeModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  const entry =
    MODEL_CATALOG.find((m) => m.id === overrides.modelId) ??
    (overrides.modelId
      ? { id: overrides.modelId, name: overrides.modelId, rate: 1 }
      : MODEL_CATALOG[0]);
  const opus = entry.id.includes("opus");
  return {
    modelId: entry.id,
    modelName: entry.name,
    description: `${entry.name} on Kiro`,
    supportedInputTypes: ["TEXT", "IMAGE"],
    rateMultiplier: entry.rate,
    tokenLimits: { maxInputTokens: 200_000, maxOutputTokens: opus ? 32_000 : 64_000 },
    ...overrides,
  };
}

/** Lowercase model ids, as GET /accounts/{id}/models/cached returns them. */
export function makeCachedModelIds(): string[] {
  return MODEL_CATALOG.map((m) => m.id);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function makeAccount(overrides: Partial<Account> = {}): Account {
  const now = nowUnix();
  return {
    id: uuid(factoryRng),
    email: "",
    userId: "",
    nickname: "",
    authMethod: "social",
    provider: "Google",
    region: "us-east-1",
    profileArn: "",
    profileArnPinned: false,
    activeRegion: "us-east-1",
    enabled: true,
    silent: false,
    silentReason: "",
    silentTime: 0,
    banStatus: "",
    banReason: "",
    banTime: 0,
    expiresAt: now + HOUR,
    hasToken: true,
    machineId: uuid(factoryRng),
    weight: 0,
    overageStatus: "",
    overageCapability: "",
    overageCap: 0,
    overageRate: 0,
    currentOverages: 0,
    overageCheckedAt: 0,
    proxyURL: "",
    subscriptionType: "",
    subscriptionTitle: "",
    daysRemaining: 0,
    usageCurrent: 0,
    usageLimit: 0,
    usagePercent: 0,
    nextResetDate: "",
    lastRefresh: 0,
    trialUsageCurrent: 0,
    trialUsageLimit: 0,
    trialUsagePercent: 0,
    trialStatus: "",
    trialExpiresAt: 0,
    requestCount: 0,
    errorCount: 0,
    totalTokens: 0,
    totalCredits: 0,
    lastUsed: 0,
    ...overrides,
  };
}

const MS_TENANT = "6a1d3f52-90c4-4b7e-8f3a-2c9d1e7b5a40";

/** The account with its secrets, as GET /accounts/{id}/full returns it. */
export function makeAccountFull(account: Account): AccountFull {
  const rng = createRng(hashSeed(account.id));
  const { hasToken, activeRegion: _activeRegion, ...rest } = account;
  const apiKey = isApiKeyAccount(account);
  const microsoft = account.authMethod === "external_idp";
  const oidc = account.authMethod === "idc" || microsoft;
  const kiroApiKey = apiKey ? `ksk_${base64ish(rng, 44)}` : "";
  return {
    ...rest,
    accessToken: apiKey ? kiroApiKey : hasToken ? `aoaAAAAAG${base64ish(rng, 180)}` : "",
    refreshToken: apiKey || !hasToken ? "" : `aorAAAAAG${base64ish(rng, 220)}`,
    kiroApiKey,
    clientId: oidc ? base64ish(rng, 22) : "",
    clientSecret: account.authMethod === "idc" ? `eyJraWQiOiJrZXktMTU2${base64ish(rng, 120)}` : "",
    tokenEndpoint: microsoft
      ? `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`
      : "",
    issuerUrl: microsoft ? `https://login.microsoftonline.com/${MS_TENANT}/v2.0` : "",
    scopes: microsoft ? "openid profile offline_access api://kiro.dev/.default" : "",
  };
}

export const MS_PROFILE_PRIMARY =
  "arn:aws:codewhisperer:eu-central-1:381492027763:profile/QK7M2XRZ9PLA";
export const MS_PROFILE_SANDBOX =
  "arn:aws:codewhisperer:us-east-1:381492027763:profile/HV4N8TQW2JDE";
export const DEFAULT_PROFILE = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";

/** Kiro profiles offered to an account: none for API keys, two for the Microsoft account. */
export function makeProfiles(account: Account): AccountProfile[] {
  if (isApiKeyAccount(account)) return [];
  if (account.authMethod === "external_idp") {
    const current = account.profileArn || MS_PROFILE_PRIMARY;
    return [
      {
        arn: MS_PROFILE_PRIMARY,
        name: "Fabrikam Engineering",
        region: "eu-central-1",
        current: current === MS_PROFILE_PRIMARY,
      },
      {
        arn: MS_PROFILE_SANDBOX,
        name: "Fabrikam Sandbox",
        region: "us-east-1",
        current: current === MS_PROFILE_SANDBOX,
      },
    ];
  }
  return [
    {
      arn: account.profileArn || DEFAULT_PROFILE,
      name: "",
      region: account.activeRegion || "us-east-1",
      current: true,
    },
  ];
}

export function makeOverage(account: Account): OverageResponse {
  return {
    success: true,
    overageStatus: account.overageStatus,
    overageCapability: account.overageCapability,
    subscriptionTitle: account.subscriptionTitle,
    overageCap: account.overageCap,
    overageRate: account.overageRate,
    currentOverages: account.currentOverages,
    overageCheckedAt: nowUnix(),
  };
}

export function makeTestResult(model: string): TestAccountResponse {
  const thinking = model.endsWith("-thinking");
  return {
    success: true,
    reply: "ok",
    model,
    stopReason: "end_turn",
    reasoning: thinking ? "The user asks for a one-word reply, so I answer ok." : "",
    inputTokens: 13,
    outputTokens: thinking ? 24 : 2,
    credits: round(0.0018 * modelRate(model.replace(/-thinking$/, "")), 4),
    contextUsage: 0.01,
  };
}

// The eight seeded accounts. Ids come from fixed seeds so requests can point at them.
const ACCOUNT_IDS = Array.from({ length: 8 }, (_, i) => uuid(createRng(7000 + i)));

/** One account per state the UI must handle (see the Task 3 fixture list). */
export function seedAccounts(): Account[] {
  const now = nowUnix();
  const reset = nextResetDate();
  const rng = createRng(4004);
  const machine = () => uuid(rng);
  return [
    makeAccount({
      id: ACCOUNT_IDS[0],
      email: "dana.whitfield@northwind-labs.com",
      userId: "d-9067642ac7.4f1b2c3d-8e9f-40a1-b2c3-d4e5f6a7b8c9",
      nickname: "Team primary",
      authMethod: "idc",
      provider: "Enterprise",
      profileArn: DEFAULT_PROFILE,
      machineId: machine(),
      expiresAt: now + 48 * 60,
      subscriptionType: "Q_DEVELOPER_STANDALONE_PRO",
      subscriptionTitle: "KIRO PRO",
      daysRemaining: 18,
      usageCurrent: 450,
      usageLimit: 1000,
      usagePercent: 0.45,
      nextResetDate: reset,
      lastRefresh: now - 10 * 60,
      overageStatus: "DISABLED",
      overageCapability: "OVERAGE_CAPABLE",
      overageCap: 100,
      overageRate: 0.04,
      overageCheckedAt: now - 2 * HOUR,
      requestCount: 1284,
      errorCount: 37,
      totalTokens: 18_420_331,
      totalCredits: 312.48,
      lastUsed: now - 40,
    }),
    makeAccount({
      id: ACCOUNT_IDS[1],
      email: "m.oyelaran@outlook.com",
      userId: "d-90661b2f4e.a7c3e9d1-5b2f-4c8a-9e1d-3f7b6a5c4d2e",
      nickname: "Overflow",
      authMethod: "idc",
      provider: "BuilderId",
      profileArn: DEFAULT_PROFILE,
      machineId: machine(),
      weight: 3,
      expiresAt: now + 31 * 60,
      subscriptionType: "Q_DEVELOPER_STANDALONE_POWER",
      subscriptionTitle: "KIRO POWER",
      daysRemaining: 9,
      usageCurrent: 9200,
      usageLimit: 10_000,
      usagePercent: 0.92,
      nextResetDate: reset,
      lastRefresh: now - 4 * 60,
      overageStatus: "ENABLED",
      overageCapability: "OVERAGE_CAPABLE",
      overageCap: 250,
      overageRate: 0.04,
      currentOverages: 0,
      overageCheckedAt: now - 30 * 60,
      requestCount: 3911,
      errorCount: 52,
      totalTokens: 64_208_115,
      totalCredits: 1488.92,
      lastUsed: now - 12,
    }),
    makeAccount({
      id: ACCOUNT_IDS[2],
      email: "priya.raman.dev@gmail.com",
      userId: "us-east-1:2b7f1c9e-4d3a-4e6b-8f5c-1a2b3c4d5e6f",
      authMethod: "social",
      provider: "Google",
      profileArn: DEFAULT_PROFILE,
      machineId: machine(),
      expiresAt: now - 3 * HOUR,
      subscriptionType: "Q_DEVELOPER_STANDALONE_FREE",
      subscriptionTitle: "KIRO FREE",
      daysRemaining: 22,
      usageCurrent: 12.5,
      usageLimit: 50,
      usagePercent: 0.25,
      nextResetDate: reset,
      lastRefresh: now - 5 * HOUR,
      requestCount: 96,
      errorCount: 4,
      totalTokens: 702_441,
      totalCredits: 12.5,
      lastUsed: now - 3 * HOUR - 300,
    }),
    makeAccount({
      id: ACCOUNT_IDS[3],
      email: "jlee.builds@protonmail.com",
      userId: "us-east-1:9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
      authMethod: "social",
      provider: "Github",
      profileArn: DEFAULT_PROFILE,
      machineId: machine(),
      enabled: false,
      banStatus: "BANNED",
      banReason: "AccessDeniedException: account access has been revoked (403)",
      banTime: now - 2 * DAY,
      expiresAt: now - 2 * DAY + HOUR,
      subscriptionType: "Q_DEVELOPER_STANDALONE_FREE",
      subscriptionTitle: "KIRO FREE",
      usageCurrent: 50,
      usageLimit: 50,
      usagePercent: 1,
      nextResetDate: reset,
      lastRefresh: now - 2 * DAY,
      requestCount: 211,
      errorCount: 19,
      totalTokens: 1_904_220,
      totalCredits: 50,
      lastUsed: now - 2 * DAY - 600,
    }),
    makeAccount({
      id: ACCOUNT_IDS[4],
      email: "ops-bot@contoso-retail.com",
      userId: "d-906612c3b8.1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      authMethod: "idc",
      provider: "Enterprise",
      profileArn: DEFAULT_PROFILE,
      machineId: machine(),
      enabled: false,
      banStatus: "SUSPENDED",
      banReason: "TEMPORARILY_SUSPENDED",
      banTime: now - 5 * HOUR,
      expiresAt: now + 20 * 60,
      subscriptionType: "Q_DEVELOPER_STANDALONE_PRO_PLUS",
      subscriptionTitle: "KIRO PRO+",
      daysRemaining: 11,
      usageCurrent: 1310,
      usageLimit: 2000,
      usagePercent: 0.655,
      nextResetDate: reset,
      lastRefresh: now - 5 * HOUR,
      requestCount: 540,
      errorCount: 61,
      totalTokens: 9_116_032,
      totalCredits: 1310,
      lastUsed: now - 5 * HOUR - 120,
    }),
    makeAccount({
      id: ACCOUNT_IDS[5],
      email: "api-key-3f9a1c0b7e2d",
      authMethod: "api_key",
      provider: "APIKey",
      region: "us-east-1",
      activeRegion: "us-east-1",
      machineId: machine(),
      expiresAt: 0,
      usageLimit: 0,
      requestCount: 802,
      errorCount: 9,
      totalTokens: 11_380_574,
      totalCredits: 204.17,
      lastUsed: now - 95,
    }),
    makeAccount({
      id: ACCOUNT_IDS[6],
      email: "elena.kovacs@fabrikam.onmicrosoft.com",
      userId: "8c1f4e2a-7b3d-4a9e-b6c5-2d1e0f9a8b7c",
      authMethod: "external_idp",
      provider: "AzureAD",
      region: "us-east-1",
      profileArn: MS_PROFILE_PRIMARY,
      profileArnPinned: true,
      activeRegion: "eu-central-1",
      machineId: machine(),
      expiresAt: now + 55 * 60,
      subscriptionType: "Q_DEVELOPER_STANDALONE_FREE",
      subscriptionTitle: "KIRO FREE",
      daysRemaining: 26,
      usageCurrent: 0,
      usageLimit: 50,
      usagePercent: 0,
      nextResetDate: reset,
      lastRefresh: now - 25 * 60,
      trialStatus: "ACTIVE",
      trialUsageCurrent: 120,
      trialUsageLimit: 500,
      trialUsagePercent: 0.24,
      trialExpiresAt: now + 3 * DAY,
      overageStatus: "",
      overageCapability: "NOT_OVERAGE_CAPABLE",
      overageCheckedAt: now - 3 * HOUR,
      requestCount: 377,
      errorCount: 6,
      totalTokens: 4_092_816,
      totalCredits: 120,
      lastUsed: now - 4 * 60,
    }),
    makeAccount({
      id: ACCOUNT_IDS[7],
      email: "",
      authMethod: "social",
      provider: "Github",
      profileArn: "",
      machineId: machine(),
      enabled: true,
      hasToken: false,
      expiresAt: 0,
    }),
  ];
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function makeApiKey(overrides: Partial<ApiKey & { key: string }> = {}): ApiKey & { key: string } {
  const key = overrides.key ?? `sk-${hex(factoryRng, 64)}`;
  return {
    id: uuid(factoryRng),
    keyMasked: maskKey(key),
    enabled: true,
    createdAt: nowUnix(),
    tokensUsed: 0,
    creditsUsed: 0,
    requestsCount: 0,
    ...overrides,
    key,
  };
}

const API_KEY_IDS = Array.from({ length: 4 }, (_, i) => uuid(createRng(8000 + i)));

/** team-a near its limits, an unnamed unlimited key, an auto-disabled key, a short custom key. */
export function seedApiKeys(): Array<ApiKey & { key: string }> {
  const now = nowUnix();
  const rng = createRng(5005);
  return [
    makeApiKey({
      id: API_KEY_IDS[0],
      name: "team-a",
      key: `sk-${hex(rng, 64)}`,
      createdAt: now - 41 * DAY,
      lastUsedAt: now - 5 * 60,
      tokenLimit: 2_000_000,
      creditLimit: 50,
      tokensUsed: 1_874_210,
      creditsUsed: 46.2,
      requestsCount: 412,
    }),
    makeApiKey({
      id: API_KEY_IDS[1],
      key: `sk-${hex(rng, 64)}`,
      createdAt: now - 17 * DAY,
      lastUsedAt: now - 40,
      tokensUsed: 523_118,
      creditsUsed: 18.4,
      requestsCount: 157,
    }),
    makeApiKey({
      id: API_KEY_IDS[2],
      name: "ci-runner",
      key: `sk-${hex(rng, 64)}`,
      enabled: false,
      createdAt: now - 9 * DAY,
      lastUsedAt: now - 2 * DAY,
      tokenLimit: 500_000,
      tokensUsed: 500_412,
      creditsUsed: 9.87,
      requestsCount: 233,
    }),
    makeApiKey({
      id: API_KEY_IDS[3],
      name: "local-dev",
      key: "kiro-dev-1",
      createdAt: now - 3 * DAY,
      tokensUsed: 0,
      creditsUsed: 0,
      requestsCount: 0,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Requests and errors
// ---------------------------------------------------------------------------

export function makeRequestRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  const inTokens = overrides.inTokens ?? 1200;
  const outTokens = overrides.outTokens ?? 300;
  return {
    ts: nowUnix(),
    accountId: "",
    model: "claude-sonnet-5",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: 0.0412,
    success: true,
    status: 200,
    endpoint: "claude",
    durationMs: 1840,
    ...overrides,
    inTokens,
    outTokens,
    totalTokens: overrides.totalTokens ?? inTokens + outTokens,
  };
}

const ENDPOINT_WEIGHTS: ReadonlyArray<readonly [RequestEndpoint, number]> = [
  ["claude", 6],
  ["openai", 3],
  ["responses", 2],
];

const ERROR_TYPES: readonly RequestErrorType[] = [
  "client_closed",
  "api_key_limit",
  "overage",
  "quota",
  "suspended",
  "profile",
  "auth",
  "stream",
  "no_accounts",
  "invalid_request",
  "rate_limit",
  "timeout",
  "upstream",
  "unknown",
];

const FAILURES: Record<RequestErrorType, { status: number; message: string }> = {
  client_closed: { status: 499, message: "client closed the connection before the response ended" },
  api_key_limit: { status: 429, message: "credit limit exceeded" },
  overage: { status: 402, message: "account {email} reached its overage cap" },
  quota: { status: 429, message: "monthly credits exhausted for {email}" },
  suspended: { status: 403, message: "TEMPORARILY_SUSPENDED: account {email} is suspended" },
  profile: { status: 400, message: "Kiro profile could not be resolved for this account" },
  auth: { status: 401, message: "upstream rejected the access token for {email} (401)" },
  stream: { status: 502, message: "stream ended before message_stop" },
  no_accounts: { status: 503, message: "no available accounts" },
  invalid_request: { status: 400, message: "messages: at least one message is required" },
  rate_limit: { status: 429, message: "ThrottlingException: Too many requests, wait and retry" },
  timeout: { status: 504, message: "upstream did not respond within 300s" },
  upstream: { status: 500, message: "InternalServerException: upstream returned 500" },
  unknown: { status: 500, message: "unexpected error while translating the response" },
};

// Auth failures happen before routing: no account, no model. One sits in the newest 25 rows.
const AUTH_FAILURE_ROWS: ReadonlyMap<
  number,
  { status: number; errorType: RequestErrorType; message: string; keyIndex?: number }
> = new Map([
  [7, { status: 401, errorType: "auth", message: "Invalid or missing API key" }],
  [151, { status: 429, errorType: "api_key_limit", message: "token limit exceeded", keyIndex: 2 }],
  [263, { status: 401, errorType: "auth", message: "API key disabled", keyIndex: 2 }],
]);

// Rows that serve traffic, by share of requests.
const ROUTED_ACCOUNTS: ReadonlyArray<readonly [number, number]> = [
  [0, 35],
  [1, 30],
  [6, 15],
  [5, 15],
  [2, 5],
];

function successTokens(rng: Rng, model: string) {
  const inTokens = int(rng, 800, rng() < 0.2 ? 120_000 : 40_000);
  const outTokens = int(rng, 40, 4200);
  const cacheReadTokens =
    rng() < 0.45 ? int(rng, Math.floor(inTokens * 0.3), Math.floor(inTokens * 0.9)) : 0;
  const cacheWriteTokens =
    rng() < 0.15 ? int(rng, 200, Math.max(200, Math.floor(inTokens * 0.2))) : 0;
  const credits = round(
    ((inTokens - cacheReadTokens * 0.9) / 100_000 + outTokens / 20_000) * modelRate(model),
    4,
  );
  return { inTokens, outTokens, cacheReadTokens, cacheWriteTokens, credits };
}

/**
 * `count` requests over the last 24 h, newest first, with persisted ids. Traffic is denser near
 * now so the 1 h and 2 h charts have data. About 8 % fail, covering every error type.
 */
export function seedRequests(nowUnix: number, count: number): RequestRecord[] {
  const rng = createRng(1001);
  const accounts = seedAccounts();
  const keys = seedApiKeys();
  const records: RequestRecord[] = [];
  let previousTs = nowUnix;
  let failureCursor = 0;

  for (let i = 0; i < count; i++) {
    const age = Math.floor(DAY * (i / count) ** 1.6) + int(rng, 0, 20);
    const ts = Math.min(previousTs, nowUnix - age);
    previousTs = ts;
    const endpoint = weighted(rng, ENDPOINT_WEIGHTS);
    const key = rng() < 0.85 ? keys[int(rng, 0, 1)] : undefined;
    const keyFields = key ? { apiKeyId: key.id, apiKeyMasked: key.keyMasked } : {};
    const base = { id: count - i, ts, endpoint };

    const authFailure = AUTH_FAILURE_ROWS.get(i);
    if (authFailure) {
      const authKey = authFailure.keyIndex === undefined ? undefined : keys[authFailure.keyIndex];
      records.push(
        makeRequestRecord({
          ...base,
          ...(authKey ? { apiKeyId: authKey.id, apiKeyMasked: authKey.keyMasked } : {}),
          accountId: "",
          model: "",
          inTokens: 0,
          outTokens: 0,
          credits: 0,
          success: false,
          status: authFailure.status,
          errorType: authFailure.errorType,
          message: authFailure.message,
          durationMs: int(rng, 2, 15),
        }),
      );
      continue;
    }

    const account = accounts[weighted(rng, ROUTED_ACCOUNTS)];
    const model = weighted(rng, MODEL_WEIGHTS);
    const routed = {
      ...base,
      ...keyFields,
      accountId: account.id,
      email: account.email || undefined,
      model,
    };

    if (i % 13 === 5) {
      const errorType = ERROR_TYPES[failureCursor++ % ERROR_TYPES.length];
      const failure = FAILURES[errorType];
      const unrouted = errorType === "no_accounts";
      records.push(
        makeRequestRecord({
          ...routed,
          ...(unrouted ? { accountId: "", email: undefined } : {}),
          inTokens: 0,
          outTokens: 0,
          credits: 0,
          success: false,
          status: failure.status,
          errorType,
          message: failure.message.replace("{email}", account.email),
          durationMs: errorType === "timeout" ? 300_000 : int(rng, 30, 9000),
        }),
      );
      continue;
    }

    let durationMs: number | undefined =
      rng() < 0.15 ? int(rng, 10_000, 55_000) : int(rng, 350, 9800);
    let rowEndpoint: RequestEndpoint | undefined = endpoint;
    if (i === 40) {
      // A row logged before durations were tracked: no duration and no endpoint.
      durationMs = undefined;
      rowEndpoint = undefined;
    } else if (i === 90) {
      durationMs = 125_000;
    }
    records.push(
      makeRequestRecord({
        ...routed,
        ...successTokens(rng, model),
        endpoint: rowEndpoint,
        durationMs,
      }),
    );
  }
  return records;
}

export function makeObserveError(overrides: Partial<ObserveError> = {}): ObserveError {
  return {
    ts: nowUnix(),
    accountId: "",
    model: "claude-sonnet-5",
    status: 429,
    message: "ThrottlingException: Too many requests, wait and retry",
    ...overrides,
  };
}

const RETRY_ERRORS: ReadonlyArray<{ status: number; message: string }> = [
  {
    status: 429,
    message: "ThrottlingException: rate exceeded for {email}, retrying on another account",
  },
  { status: 502, message: "upstream connection reset, retrying" },
  { status: 500, message: "InternalServerException: upstream returned 500, retrying" },
  { status: 403, message: "access token for {email} expired, refreshed and retried" },
];

/** 40 error events, newest first: every failed request plus retried upstream errors. */
export function seedErrors(requests: RequestRecord[]): ObserveError[] {
  const rng = createRng(2002);
  const accounts = seedAccounts();
  const errors: ObserveError[] = requests
    .filter((r) => !r.success)
    .map((r) =>
      makeObserveError({
        ts: r.ts,
        accountId: r.accountId,
        email: r.email,
        model: r.model || undefined,
        status: r.status,
        message: (r.message ?? "").slice(0, 240),
      }),
    );
  const succeeded = requests.filter((r) => r.success && r.accountId);
  while (errors.length < 40 && succeeded.length > 0) {
    const request = pick(rng, succeeded);
    const other = accounts[pick(rng, [0, 1, 6])];
    const retry = pick(rng, RETRY_ERRORS);
    errors.push(
      makeObserveError({
        ts: request.ts - int(rng, 1, 4),
        accountId: other.id,
        email: other.email,
        model: request.model,
        status: retry.status,
        message: retry.message.replace("{email}", other.email),
      }),
    );
  }
  return errors.sort((a, b) => b.ts - a.ts).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Observe aggregates
// ---------------------------------------------------------------------------

function minuteOffset(ts: number, nowUnix: number): number {
  return Math.floor(nowUnix / 60) - Math.floor(ts / 60);
}

/** Minutes the Go rings keep (and rebuild from SQLite on start). */
const RING_MINUTES = 1440;
/** Minutes in the overview series. */
const SERIES_MINUTES = 30;
/** Minutes that rank accounts for top=N. */
const TOP_RANK_MINUTES = 60;

type CellSums = {
  offset: number;
  reqs: number;
  failures: number;
  retries: number;
  credits: number;
};

function emptyCells(count: number): CellSums[] {
  return Array.from({ length: count }, (_, offset) => ({
    offset,
    reqs: 0,
    failures: 0,
    retries: 0,
    credits: 0,
  }));
}

function isEmptyCell(cell: CellSums): boolean {
  return cell.reqs === 0 && cell.failures === 0 && cell.retries === 0 && cell.credits === 0;
}

/** Like Go's JSON: `retries` and `credits` are omitted when 0; sparse rows drop empty cells. */
function finishCells(cells: CellSums[], sparse: boolean): HeatmapCell[] {
  return cells
    .filter((cell) => !sparse || !isEmptyCell(cell))
    .map(({ retries, credits, ...cell }) => ({
      ...cell,
      ...(retries > 0 ? { retries } : {}),
      ...(credits > 0 ? { credits: round(credits, 4) } : {}),
    }));
}

/** The query params of GET /observe/account-heatmap, plus the errors log retries come from. */
interface BuildHeatmapOptions {
  /** failed upstream attempts (the mock's recent-errors ring); each adds a retry */
  errors?: readonly ObserveError[];
  scope?: "global" | "all";
  top?: number;
  sparse?: boolean;
  bucketMin?: number;
}

/**
 * The account heatmap like Go: offset 0 is the current minute (or bucket). `reqs` and
 * `failures` count final requests, `retries` count failed attempts. Accounts are the configured
 * ones with traffic in the last day (Go prunes deleted ones), sorted by id, or with `top` the
 * busiest by requests plus retries over the last hour, idle ones left out.
 */
export function buildHeatmap(
  requests: readonly RequestRecord[],
  accounts: readonly Account[],
  windowMin: number,
  nowUnix: number,
  options: BuildHeatmapOptions = {},
): HeatmapData & { restCount?: number } {
  const bucketMin = Math.min(Math.max(1, options.bucketMin ?? 1), windowMin);
  const count = Math.ceil(windowMin / bucketMin);
  const emails = new Map(accounts.map((a) => [a.id, a.email]));
  const global = emptyCells(count);
  const rows = new Map<string, { cells: CellSums[]; rank: number }>();
  const add = (
    accountId: string,
    ts: number,
    apply: (cell: CellSums) => void,
    rankBy: number,
  ): void => {
    const offset = minuteOffset(ts, nowUnix);
    if (offset < 0 || offset >= RING_MINUTES) return;
    let row: { cells: CellSums[]; rank: number } | undefined;
    if (accountId && emails.has(accountId)) {
      row = rows.get(accountId);
      if (!row) {
        row = { cells: emptyCells(count), rank: 0 };
        rows.set(accountId, row);
      }
      if (offset < TOP_RANK_MINUTES) row.rank += rankBy;
    }
    if (offset >= windowMin) return;
    const index = Math.floor(offset / bucketMin);
    apply(global[index]);
    if (row) apply(row.cells[index]);
  };
  for (const r of requests) {
    add(
      r.accountId,
      r.ts,
      (cell) => {
        cell.reqs += 1;
        if (!r.success) cell.failures += 1;
        cell.credits += r.credits;
      },
      1,
    );
  }
  for (const e of options.errors ?? []) {
    add(e.accountId, e.ts, (cell) => (cell.retries += 1), 1);
  }

  const sparse = options.sparse ?? false;
  const toRow = (accountId: string, cells: CellSums[]) => {
    const email = emails.get(accountId);
    return { accountId, ...(email ? { email } : {}), cells: finishCells(cells, sparse) };
  };
  const result: HeatmapData & { restCount?: number } = {
    windowMin,
    bucketMin,
    nowUnix,
    global: { accountId: "_global_", cells: finishCells(global, sparse) },
    accounts: [],
  };
  if (options.scope === "global") return result;
  const top = options.top ?? 0;
  if (top > 0) {
    const busy = [...rows.entries()]
      .filter(([, row]) => row.rank > 0)
      .sort(([a, x], [b, y]) => y.rank - x.rank || (a < b ? -1 : a > b ? 1 : 0));
    result.accounts = busy.slice(0, top).map(([id, row]) => toRow(id, row.cells));
    result.restCount = Math.max(0, busy.length - top);
    return result;
  }
  result.accounts = [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, row]) => toRow(id, row.cells));
  return result;
}

/** Go's accountAvailability: enabled, and of those the ones that can take traffic. */
export function buildAvailability(
  accounts: readonly Account[],
  allowOverUsage: boolean,
): { enabledAccts: number; availableAccts: number } {
  let enabledAccts = 0;
  let availableAccts = 0;
  for (const a of accounts) {
    if (!a.enabled) continue;
    enabledAccts += 1;
    if (a.silent || isBanned(a)) continue;
    if (isExhausted(a) && !allowOverUsage && a.overageStatus.toUpperCase() !== "ENABLED") continue;
    availableAccts += 1;
  }
  return { enabledAccts, availableAccts };
}

/** What GET /observe/overview reads besides the request log. */
interface BuildOverviewContext {
  /** failed upstream attempts; each adds a retry */
  errors?: readonly ObserveError[];
  /** configured accounts, for enabledAccts/availableAccts and the ring prune */
  accounts?: readonly Account[];
  allowOverUsage?: boolean;
}

/**
 * GET /observe/overview like Go: the rings hold final requests from the last day whatever the
 * process start, retries come from the errors log, and `series` is the last 30 minutes, oldest
 * first.
 */
export function buildOverview(
  requests: readonly RequestRecord[],
  nowUnix: number,
  startedAt: number,
  context: BuildOverviewContext = {},
): ObserveOverview {
  let rpm1 = 0;
  let reqs5 = 0;
  let failures5 = 0;
  let successes5 = 0;
  let in5 = 0;
  let out5 = 0;
  let credits5 = 0;
  let credits60 = 0;
  let errors60 = 0;
  let successes60 = 0;
  let retries60 = 0;
  const known = context.accounts ? new Set(context.accounts.map((a) => a.id)) : null;
  const ringAccount = (id: string) => id !== "" && (known === null || known.has(id));
  const active = new Set<string>();
  const ringAccounts = new Set<string>();
  const models = new Set<string>();
  const series = {
    rpm: Array<number>(SERIES_MINUTES).fill(0),
    failures: Array<number>(SERIES_MINUTES).fill(0),
    inTpm: Array<number>(SERIES_MINUTES).fill(0),
    outTpm: Array<number>(SERIES_MINUTES).fill(0),
    credits: Array<number>(SERIES_MINUTES).fill(0),
  };
  for (const r of requests) {
    if (r.model) models.add(r.model);
    const offset = minuteOffset(r.ts, nowUnix);
    if (offset < 0 || offset >= RING_MINUTES) continue;
    if (ringAccount(r.accountId)) ringAccounts.add(r.accountId);
    if (offset >= 60) continue;
    if (r.success) successes60 += 1;
    else errors60 += 1;
    credits60 += r.credits;
    if (offset < SERIES_MINUTES) {
      const at = SERIES_MINUTES - 1 - offset;
      series.rpm[at] += 1;
      if (!r.success) series.failures[at] += 1;
      series.inTpm[at] += r.inTokens;
      series.outTpm[at] += r.outTokens;
      series.credits[at] += r.credits;
    }
    if (offset >= 5) continue;
    if (offset === 0) rpm1 += 1;
    reqs5 += 1;
    if (ringAccount(r.accountId)) active.add(r.accountId);
    if (r.success) successes5 += 1;
    else failures5 += 1;
    in5 += r.inTokens;
    out5 += r.outTokens;
    credits5 += r.credits;
  }
  for (const e of context.errors ?? []) {
    if (e.model) models.add(e.model);
    const offset = minuteOffset(e.ts, nowUnix);
    if (offset < 0 || offset >= RING_MINUTES) continue;
    if (ringAccount(e.accountId)) ringAccounts.add(e.accountId);
    if (offset < 60) retries60 += 1;
  }
  return {
    startedAt,
    nowUnix,
    rpm1,
    rpm5Avg: reqs5 / 5,
    errRate5: failures5 + successes5 > 0 ? failures5 / (failures5 + successes5) : 0,
    inTpm5: in5 / 5,
    outTpm5: out5 / 5,
    credits5: round(credits5, 4),
    credits60: round(credits60, 4),
    errors60,
    successes60,
    retries60,
    activeAccts: active.size,
    totalAccts: ringAccounts.size,
    totalModels: models.size,
    ...buildAvailability(context.accounts ?? [], context.allowOverUsage ?? false),
    series: {
      rpm: series.rpm,
      errRate: series.rpm.map((reqs, i) => (reqs > 0 ? series.failures[i] / reqs : 0)),
      inTpm: series.inTpm,
      outTpm: series.outTpm,
      credits: series.credits.map((c) => round(c, 4)),
    },
  };
}

function makeModelMixEntry(overrides: Partial<ModelMixEntry> = {}): ModelMixEntry {
  return {
    model: "claude-sonnet-5",
    reqs: 0,
    retries: 0,
    inTokens: 0,
    outTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: 0,
    lastUsed: nowUnix(),
    ...overrides,
  };
}

/**
 * Like Go: every final request counts once, with its tokens and credits, success or failure;
 * each failed attempt in the errors log adds a retry. Sorted by credits, highest first.
 */
export function buildModelMix(
  requests: readonly RequestRecord[],
  errors: readonly ObserveError[] = [],
): ModelMixEntry[] {
  const byModel = new Map<string, ModelMixEntry>();
  const entryFor = (model: string): ModelMixEntry => {
    let entry = byModel.get(model);
    if (!entry) {
      entry = makeModelMixEntry({ model, lastUsed: 0 });
      byModel.set(model, entry);
    }
    return entry;
  };
  for (const r of requests) {
    if (!r.model) continue;
    const entry = entryFor(r.model);
    entry.reqs += 1;
    entry.lastUsed = Math.max(entry.lastUsed, r.ts);
    entry.inTokens += r.inTokens;
    entry.outTokens += r.outTokens;
    entry.cacheReadTokens += r.cacheReadTokens;
    entry.cacheWriteTokens += r.cacheWriteTokens;
    entry.credits += r.credits;
  }
  for (const e of errors) {
    if (!e.model) continue;
    const entry = entryFor(e.model);
    entry.retries = (entry.retries ?? 0) + 1;
  }
  return [...byModel.values()]
    .map((entry) => ({ ...entry, credits: round(entry.credits, 4) }))
    .sort((a, b) => b.credits - a.credits || b.reqs - a.reqs || a.model.localeCompare(b.model));
}

function isBanned(account: Account): boolean {
  return account.banStatus !== "" && account.banStatus !== "ACTIVE";
}

function isExhausted(account: Account): boolean {
  return account.usageLimit > 0 && account.usageCurrent >= account.usageLimit;
}

/** GET /status from the mock database, with the Go definitions of each count. */
export function buildStatus(db: MockDb): StatusResponse {
  const now = nowUnix();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const midnightUnix = Math.floor(midnight.getTime() / 1000);
  const available = db.accounts.filter(
    (a) =>
      a.enabled &&
      a.hasToken &&
      !isBanned(a) &&
      (!isExhausted(a) ||
        a.overageStatus.toUpperCase() === "ENABLED" ||
        db.settings.allowOverUsage),
  ).length;
  let successRequests = 0;
  let totalTokens = 0;
  let totalCredits = 0;
  let successTokens = 0;
  let successInTokens = 0;
  let successOutTokens = 0;
  let successCredits = 0;
  for (const r of db.requests) {
    totalTokens += r.totalTokens;
    totalCredits += r.credits;
    if (!r.success) continue;
    successRequests += 1;
    successTokens += r.totalTokens;
    successInTokens += r.inTokens;
    successOutTokens += r.outTokens;
    successCredits += r.credits;
  }
  return {
    status: "ok",
    version: db.version,
    accounts: db.accounts.length,
    available,
    accountCreditsUsed: round(
      db.accounts.reduce((sum, a) => sum + a.usageCurrent, 0),
      4,
    ),
    accountCreditsLimit: db.accounts.reduce((sum, a) => sum + a.usageLimit, 0),
    totalRequests: db.requests.length,
    successRequests,
    failedRequests: db.requests.length - successRequests,
    totalTokens,
    totalCredits: round(totalCredits, 4),
    successTokens,
    successInTokens,
    successOutTokens,
    successCredits: round(successCredits, 4),
    totalErrorEvents: db.errors.length,
    uptime: Math.max(0, now - db.startedAt),
    totalBanned: db.accounts.filter(isBanned).length,
    todayBanned: db.accounts.filter((a) => isBanned(a) && a.banTime >= midnightUnix).length,
    totalExhausted: db.accounts.filter(isExhausted).length,
  };
}

// ---------------------------------------------------------------------------
// Backups and export
// ---------------------------------------------------------------------------

export function backupId(createdAt: number, rng: Rng): string {
  const d = new Date(createdAt * 1000);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}-${time}-${pad(int(rng, 0, 999_999_999), 9)}-${hex(rng, 8)}`;
}

/** The note the UI writes for a manual backup: local time `YYYY-MM-DD HH:MM:SS`. */
export function manualNote(createdAt: number): string {
  const d = new Date(createdAt * 1000);
  return `manual backup ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function makeBackupEntry(overrides: Partial<BackupEntry> = {}): BackupEntry {
  const createdAt = overrides.createdAt ?? nowUnix();
  const id = overrides.id ?? backupId(createdAt, factoryRng);
  return {
    id,
    createdAt,
    kind: "manual",
    file: `${id}.json`,
    size: int(factoryRng, 38_000, 62_000),
    sha256: hex(factoryRng, 64),
    accountCnt: 8,
    version: "2.1.0",
    format: "kiro-proxy-backup",
    includesCredentials: true,
    ...overrides,
  };
}

/** Five backups, newest first: manual, two scheduled and two rollback points. Go makes no "auto" kind. */
export function seedBackups(nowUnix: number): BackupEntry[] {
  const rng = createRng(3003);
  const entry = (createdAt: number, fields: Partial<BackupEntry>): BackupEntry => {
    const id = backupId(createdAt, rng);
    return makeBackupEntry({
      id,
      createdAt,
      file: `${id}.json`,
      size: int(rng, 38_000, 62_000),
      sha256: hex(rng, 64),
      ...fields,
    });
  };
  const manualAt = nowUnix - 2 * HOUR - 7 * 60;
  const olderScheduled = entry(nowUnix - 44 * HOUR, {
    kind: "scheduled",
    note: "auto-daily",
    accountCnt: 7,
  });
  return [
    entry(manualAt, { kind: "manual", note: manualNote(manualAt) }),
    entry(nowUnix - 20 * HOUR, { kind: "scheduled", note: "auto-daily" }),
    entry(nowUnix - 30 * HOUR, {
      kind: "pre-restore",
      note: `auto before restore ${olderScheduled.id}`,
      restoredAccountCnt: 7,
    }),
    olderScheduled,
    entry(nowUnix - 3 * DAY, {
      kind: "pre-restore",
      note: "upload kiro-backup-x.json",
      accountCnt: 7,
      restoredAccountCnt: 6,
    }),
  ];
}

function exportSubscription(type: string): ExportAccount["subscription"]["type"] {
  if (type.includes("PRO_PLUS")) return "Pro_Plus";
  if (type.includes("PRO") || type.includes("POWER")) return "Pro";
  return "Free";
}

/** POST /export: Kiro Account Manager format, times in ms, with live secrets. */
export function makeExport(accounts: Account[]): ExportData {
  const nowMs = Date.now();
  return {
    version: "2.1.0",
    exportedAt: nowMs,
    accounts: accounts.map((account) => {
      const full = makeAccountFull(account);
      return {
        id: account.id,
        email: account.email,
        ...(account.nickname ? { nickname: account.nickname } : {}),
        idp: account.provider || account.authMethod,
        ...(account.userId ? { userId: account.userId } : {}),
        ...(account.profileArn ? { profileArn: account.profileArn } : {}),
        ...(account.machineId ? { machineId: account.machineId } : {}),
        credentials: {
          accessToken: full.accessToken,
          csrfToken: "",
          refreshToken: full.refreshToken,
          ...(full.kiroApiKey ? { kiroApiKey: full.kiroApiKey } : {}),
          ...(full.clientId ? { clientId: full.clientId } : {}),
          ...(full.clientSecret ? { clientSecret: full.clientSecret } : {}),
          region: account.region,
          expiresAt: account.expiresAt * 1000,
          authMethod: account.authMethod === "idc" ? "IdC" : account.authMethod,
          ...(account.provider ? { provider: account.provider } : {}),
          ...(full.tokenEndpoint ? { tokenEndpoint: full.tokenEndpoint } : {}),
          ...(full.issuerUrl ? { issuerUrl: full.issuerUrl } : {}),
          ...(full.scopes ? { scopes: full.scopes } : {}),
        },
        subscription: {
          type: exportSubscription(account.subscriptionType),
          ...(account.subscriptionTitle ? { title: account.subscriptionTitle } : {}),
        },
        usage: {
          current: account.usageCurrent,
          limit: account.usageLimit,
          percentUsed: round(account.usagePercent * 100, 2),
          lastUpdated: nowMs,
        },
        tags: [],
        status: "active",
        createdAt: nowMs,
        lastUsedAt: nowMs,
      };
    }),
    groups: [],
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Settings defaults (the Go server defaults)
// ---------------------------------------------------------------------------

export function defaultSettings(): Settings {
  return {
    requireApiKey: false,
    port: 8080,
    host: "0.0.0.0",
    allowOverUsage: false,
    lenientStreamIntegrity: false,
    sessionAffinity: true,
    autoContinue: false,
    autoContinueMax: 3,
    structuredToolHistory: true,
    imageResize: true,
    imageResizeMaxDimension: 1568,
    imageResizeMaxKB: 400,
  };
}

export function defaultThinking(): ThinkingConfig {
  return { suffix: "-thinking", openaiFormat: "reasoning_content", claudeFormat: "thinking" };
}

/** The nine built-in mappings (config/config.go), in order: order matters for substring matches. */
export function defaultModelMappings(): ModelMappingRule[] {
  return [
    { key: "claude-sonnet-4-20250514", value: "claude-sonnet-5" },
    { key: "claude-3-5-sonnet", value: "claude-sonnet-5" },
    { key: "claude-3-sonnet", value: "claude-sonnet-5" },
    { key: "claude-3-opus", value: "claude-opus-5" },
    { key: "claude-3-haiku", value: "claude-haiku-4.5" },
    { key: "gpt-5.4-mini", value: "claude-haiku-4.5" },
    { key: "gpt-5", value: "claude-opus-5" },
    { key: "gpt-4-turbo", value: "claude-sonnet-5" },
    { key: "gpt-3.5-turbo", value: "claude-sonnet-5" },
  ];
}

export function defaultEndpoint(): EndpointConfig {
  return { preferredEndpoint: "auto", endpointFallback: true };
}

export function defaultPromptFilter(): PromptFilterConfig {
  return {
    filterClaudeCode: false,
    filterEnvNoise: false,
    filterStripBoundaries: false,
    rules: [],
  };
}
