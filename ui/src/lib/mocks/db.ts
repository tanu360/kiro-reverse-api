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
  defaultEndpoint,
  defaultModelMappings,
  defaultPromptFilter,
  defaultProxy,
  defaultSettings,
  defaultThinking,
} from "./fixtures";

export interface MockDb {
  /** '12345678' */
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

// Skeleton: Task 3 seeds realistic data. Until then every list is empty.
function seedDb(): MockDb {
  return {
    adminPassword: "12345678",
    firstRunPending: true,
    failedLogins: 0,
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
    modelMappings: defaultModelMappings(),
    endpoint: defaultEndpoint(),
    proxy: defaultProxy(),
    promptFilter: defaultPromptFilter(),
    startedAt: mockNowUnix(),
    version: "2.1.0",
    pending: { iam: {}, microsoft: {}, builderId: {} },
  };
}

export const mockDb: MockDb = seedDb();

/** Re-seeds in place, so imported references stay valid. */
export function resetMockDb(): void {
  Object.assign(mockDb, seedDb());
}
