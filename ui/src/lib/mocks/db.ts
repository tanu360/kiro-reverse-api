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
  promptFilter: PromptFilterConfig;
  startedAt: number;
  /** '2.1.0' */
  version: string;
  pending: {
    iam: Record<string, unknown>;
    microsoft: Record<string, unknown>;
    builderId: Record<string, { polls: number }>;
  };
}

export function mockNowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

const SEED_REQUEST_COUNT = 320;

/** Where the browser mock keeps its generated password, so it survives reloads like the real one. */
const MOCK_PASSWORD_KEY = "kiro_mock_password";

/**
 * The first-run password as config/admin_password.go makes it: 8 crypto-random digits,
 * zero-padded ("%08d"). It is drawn once and kept in localStorage, so it stays the same across
 * reloads, as the real one does until it is claimed; setting that key pins a known one (e2e).
 * Unit tests keep the fixed 12345678.
 */
function mockAdminPassword(): string {
  if (import.meta.env.MODE === "test") return "12345678";
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

function seedDb(): MockDb {
  const now = mockNowUnix();
  const accounts = seedAccounts();
  const requests = seedRequests(now, SEED_REQUEST_COUNT);
  return {
    adminPassword: mockAdminPassword(),
    firstRunPending: true,
    failedLogins: 0,
    accounts,
    secrets: Object.fromEntries(accounts.map((account) => [account.id, makeAccountFull(account)])),
    apiKeys: seedApiKeys(),
    requests,
    errors: seedErrors(requests),
    modelMix: buildModelMix(requests),
    backups: seedBackups(now),
    schedule: { enabled: true, cadence: "daily", keep: 14, lastRun: now - 6 * 3600 },
    settings: defaultSettings(),
    thinking: defaultThinking(),
    modelMappings: defaultModelMappings(),
    endpoint: defaultEndpoint(),
    proxy: { proxyURL: "socks5://user:p%40ss@127.0.0.1:1080" },
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
    version: "2.1.0",
    pending: { iam: {}, microsoft: {}, builderId: {} },
  };
}

export const mockDb: MockDb = seedDb();

/** Re-seeds in place, so imported references stay valid. */
export function resetMockDb(): void {
  Object.assign(mockDb, seedDb());
}
