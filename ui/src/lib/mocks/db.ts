import type { CountTokensAuthType } from "@/lib/api/count-tokens";
import type {
  Account,
  AccountFull,
  ApiKey,
  BackupEntry,
  BackupSchedule,
  EndpointConfig,
  ModelMappingRule,
  ModelMixEntry,
  ObserveError,
  PromptFilterConfig,
  ProxyConfig,
  RequestRecord,
  Settings,
  ThinkingConfig,
} from "@/lib/api/types";
import {
  buildModelMix,
  defaultEndpoint,
  defaultModelMappings,
  defaultPromptFilter,
  defaultSettings,
  defaultThinking,
  makeAccountFull,
  seedAccounts,
  seedApiKeys,
  seedBackups,
  seedErrors,
  seedRequests,
} from "./fixtures";
import { seedFullDataset } from "./fixtures-full";

/**
 * Which dataset the mock serves. `small` is the unit-test seed (8 accounts, 320 requests);
 * `full` is the large browser dataset with every value the server can send; `empty` is a fresh
 * install. Unit tests always run `small`; the browser picks one in scenario.ts.
 */
export type MockScenario = "full" | "small" | "empty";
export const MOCK_SCENARIOS: readonly MockScenario[] = ["full", "small", "empty"];

export interface MockDb {
  /** 8 random digits, as the real first-run password (12345678 in unit tests) */
  adminPassword: string;
  /** true until the first successful sign-in */
  firstRunPending: boolean;
  /** 5 failures -> 429 with Retry-After: 60 */
  failedLogins: number;
  accounts: Account[];
  secrets: Record<string, AccountFull>;
  apiKeys: Array<ApiKey & { key: string }>;
  /** newest first, persisted ids */
  requests: RequestRecord[];
  errors: ObserveError[];
  modelMix: ModelMixEntry[];
  backups: BackupEntry[];
  schedule: BackupSchedule;
  settings: Settings;
  thinking: ThinkingConfig;
  modelMappings: ModelMappingRule[];
  endpoint: EndpointConfig;
  proxy: ProxyConfig;
  /** The external count_tokens API as Go stores it; GET answers the key masked. */
  countTokens: MockCountTokens;
  promptFilter: PromptFilterConfig;
  startedAt: number;
  /** '2.1.0' */
  version: string;
  /** What the update check (version.json on GitHub) answers. */
  remoteVersion: { version: string; changelog: string };
  pending: {
    iam: Record<string, unknown>;
    microsoft: Record<string, unknown>;
    builderId: Record<string, { polls: number }>;
  };
}

export interface MockCountTokens {
  url: string;
  authType: CountTokensAuthType;
  key: string;
}

/** No external API: count_tokens answers with the local estimate. */
function localCountTokens(): MockCountTokens {
  return { url: "", authType: "x-api-key", key: "" };
}

export function mockNowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

const SEED_REQUEST_COUNT = 320;

/** Where the browser mock keeps its generated password, so it survives reloads like the real one. */
const MOCK_PASSWORD_KEY = "kiro_mock_password";
const MOCK_FIRST_RUN_KEY = "kiro_mock_first_run_done";

function mockFirstRunPending(): boolean {
  if (import.meta.env.VITE_MOCK !== "1") return true;
  try {
    return localStorage.getItem(MOCK_FIRST_RUN_KEY) !== "1";
  } catch {
    return true;
  }
}

/** The mock's server-side auth state must survive a page reload, just like its password. */
export function claimMockPassword(password = mockDb.adminPassword): void {
  mockDb.adminPassword = password;
  mockDb.firstRunPending = false;
  if (import.meta.env.VITE_MOCK !== "1") return;
  try {
    localStorage.setItem(MOCK_PASSWORD_KEY, password);
    localStorage.setItem(MOCK_FIRST_RUN_KEY, "1");
  } catch {
    /* Storage may be unavailable in a sandboxed preview. */
  }
}

/**
 * The first-run password as config/admin_password.go makes it: 8 crypto-random digits,
 * zero-padded ("%08d"). It is drawn once and kept in localStorage, so it stays the same across
 * reloads, as the real one does until it is claimed; setting that key pins a known one (e2e).
 * VITE_MOCK_PASSWORD (in ui/.env.mock.local, never committed) pins one for a whole dev machine,
 * over whatever the browser kept. Unit tests keep the fixed 12345678.
 */
function mockAdminPassword(): string {
  if (import.meta.env.MODE === "test") return "12345678";
  const pinned = import.meta.env.VITE_MOCK_PASSWORD;
  if (pinned) return pinned;
  try {
    const stored = localStorage.getItem(MOCK_PASSWORD_KEY);
    if (stored) return stored;
  } catch {
    // No storage (private mode): a fresh password per load is fine.
  }
  const [random] = crypto.getRandomValues(new Uint32Array(1));
  const password = String(random % 100_000_000).padStart(8, "0");
  try {
    localStorage.setItem(MOCK_PASSWORD_KEY, password);
  } catch {
    // As above.
  }
  return password;
}

const REMOTE_CHANGELOG = [
  "🧭 Requests can be filtered by API key, endpoint and error type, and the filters stay in the URL.",
  "📈 The Overview heatmap groups quiet accounts so a pool of 100+ accounts stays readable.",
  "🔁 Failover now skips accounts whose overage cap is reached instead of retrying them first.",
  "🌍 New: per-account proxy URLs accept socks5h:// with credentials.",
  "🛠️ Fixed: a restore from a backup without credentials no longer clears refresh tokens.",
].join("\n");

/** The common fields every scenario shares. */
function baseDb(): Pick<
  MockDb,
  "adminPassword" | "firstRunPending" | "failedLogins" | "version" | "remoteVersion" | "pending"
> {
  return {
    adminPassword: mockAdminPassword(),
    firstRunPending: mockFirstRunPending(),
    failedLogins: 0,
    version: "2.1.0",
    // Same as the running version: no update notice in tests, screenshots or axe runs.
    remoteVersion: { version: "2.1.0", changelog: "" },
    pending: { iam: {}, microsoft: {}, builderId: {} },
  };
}

/** Large and varied: every union value, extremes and 30 days of traffic (fixtures-full.ts). */
function seedFullDb(now: number): MockDb {
  const data = seedFullDataset(now);
  return {
    ...baseDb(),
    ...data,
    modelMix: buildModelMix(data.requests, data.errors),
    countTokens: {
      url: "https://api.anthropic.com/v1/messages/count_tokens",
      authType: "x-api-key",
      key: "sk-ant-api03-mock-count-tokens-7Qf2",
    },
    // An update is out, so the update notice shows.
    remoteVersion: { version: "2.2.0", changelog: REMOTE_CHANGELOG },
  };
}

/** A fresh install: nothing configured, nothing served, just started. */
function seedEmptyDb(now: number): MockDb {
  return {
    ...baseDb(),
    accounts: [],
    secrets: {},
    apiKeys: [],
    requests: [],
    errors: [],
    modelMix: [],
    backups: [],
    schedule: {},
    settings: defaultSettings(),
    thinking: defaultThinking(),
    modelMappings: [],
    endpoint: defaultEndpoint(),
    proxy: { proxyURL: "" },
    countTokens: localCountTokens(),
    promptFilter: defaultPromptFilter(),
    startedAt: now - 42,
  };
}

function seedDb(scenario: MockScenario): MockDb {
  const now = mockNowUnix();
  if (scenario === "full") return seedFullDb(now);
  if (scenario === "empty") return seedEmptyDb(now);
  const accounts = seedAccounts();
  const requests = seedRequests(now, SEED_REQUEST_COUNT);
  const errors = seedErrors(requests);
  return {
    ...baseDb(),
    accounts,
    secrets: Object.fromEntries(accounts.map((account) => [account.id, makeAccountFull(account)])),
    apiKeys: seedApiKeys(),
    requests,
    errors,
    modelMix: buildModelMix(requests, errors),
    backups: seedBackups(now),
    schedule: { enabled: true, cadence: "daily", keep: 14, lastRun: now - 6 * 3600 },
    settings: defaultSettings(),
    thinking: defaultThinking(),
    modelMappings: defaultModelMappings(),
    endpoint: defaultEndpoint(),
    proxy: { proxyURL: "socks5://user:p%40ss@127.0.0.1:1080" },
    countTokens: localCountTokens(),
    promptFilter: {
      ...defaultPromptFilter(),
      rules: [
        {
          id: "rule-1761900000000",
          name: "Hide internal hostnames",
          type: "regex",
          match: "\\b[a-z0-9-]+\\.corp\\.northwind-labs\\.com\\b",
          replace: "internal-host",
          enabled: true,
        },
        {
          id: "rule-1761900060000",
          name: "Drop telemetry lines",
          type: "lines-containing",
          match: "telemetry-session-id",
          enabled: true,
        },
      ],
    },
    // The process "started" before the oldest seeded request, so every request counts.
    startedAt: now - 26 * 3600,
  };
}

let scenario: MockScenario = "small";

export const mockDb: MockDb = seedDb(scenario);

/** The dataset the mock serves now. */
export function mockScenario(): MockScenario {
  return scenario;
}

/**
 * Re-seeds in place, so imported references stay valid. Without an argument it keeps the current
 * scenario, so the unit-test reset after each test stays on the small seed.
 */
export function resetMockDb(next: MockScenario = scenario): void {
  scenario = next;
  Object.assign(mockDb, seedDb(next));
}
