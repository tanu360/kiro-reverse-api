import type {
  Account,
  AccountFull,
  AccountProfile,
  ApiKey,
  BackupEntry,
  EndpointConfig,
  ExportData,
  HeatmapData,
  ModelInfo,
  ModelMappingRule,
  ModelMixEntry,
  ObserveError,
  ObserveOverview,
  OverageResponse,
  PromptFilterConfig,
  ProxyConfig,
  RequestRecord,
  Settings,
  StatusResponse,
  TestAccountResponse,
  ThinkingConfig,
} from "@/lib/api/types";
import type { MockDb } from "./db";

// Skeleton: Task 3 implements the seeded fixture factories. Seeds return empty lists and the
// defaults match the Go server defaults; factories and builders throw until Task 3 lands.

const notImplemented = (): never => {
  throw new Error("not implemented");
};

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

export function makeAccount(_overrides?: Partial<Account>): Account {
  return notImplemented();
}

export function makeAccountFull(_account: Account): AccountFull {
  return notImplemented();
}

export function makeModelInfo(_overrides?: Partial<ModelInfo>): ModelInfo {
  return notImplemented();
}

export function makeCachedModelIds(): string[] {
  return [];
}

export function makeProfiles(_account: Account): AccountProfile[] {
  return [];
}

export function makeOverage(_account: Account): OverageResponse {
  return notImplemented();
}

export function makeTestResult(_model: string): TestAccountResponse {
  return notImplemented();
}

export function makeApiKey(
  _overrides?: Partial<ApiKey & { key: string }>,
): ApiKey & { key: string } {
  return notImplemented();
}

export function makeRequestRecord(_overrides?: Partial<RequestRecord>): RequestRecord {
  return notImplemented();
}

export function makeObserveError(_overrides?: Partial<ObserveError>): ObserveError {
  return notImplemented();
}

export function makeModelMixEntry(_overrides?: Partial<ModelMixEntry>): ModelMixEntry {
  return notImplemented();
}

export function makeBackupEntry(_overrides?: Partial<BackupEntry>): BackupEntry {
  return notImplemented();
}

export function makeExport(_accounts: Account[]): ExportData {
  return notImplemented();
}

export function buildHeatmap(
  _requests: RequestRecord[],
  _accounts: Account[],
  _windowMin: number,
  _nowUnix: number,
): HeatmapData {
  return notImplemented();
}

export function buildOverview(
  _requests: RequestRecord[],
  _nowUnix: number,
  _startedAt: number,
): ObserveOverview {
  return notImplemented();
}

export function buildModelMix(_requests: RequestRecord[]): ModelMixEntry[] {
  return [];
}

export function buildStatus(_db: MockDb): StatusResponse {
  return notImplemented();
}

export function seedAccounts(): Account[] {
  return [];
}

export function seedApiKeys(): Array<ApiKey & { key: string }> {
  return [];
}

export function seedRequests(_nowUnix: number, _count: number): RequestRecord[] {
  return [];
}

export function seedErrors(_requests: RequestRecord[]): ObserveError[] {
  return [];
}

export function seedBackups(_nowUnix: number): BackupEntry[] {
  return [];
}

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
  };
}

export function defaultThinking(): ThinkingConfig {
  return { suffix: "-thinking", openaiFormat: "reasoning_content", claudeFormat: "thinking" };
}

/** The nine built-in mappings from research/area-settings-backups.md §1. Skeleton: empty. */
export function defaultModelMappings(): ModelMappingRule[] {
  return [];
}

export function defaultEndpoint(): EndpointConfig {
  return { preferredEndpoint: "auto", endpointFallback: true };
}

export function defaultProxy(): ProxyConfig {
  return { proxyURL: "" };
}

export function defaultPromptFilter(): PromptFilterConfig {
  return {
    filterClaudeCode: false,
    filterEnvNoise: false,
    filterStripBoundaries: false,
    rules: [],
  };
}
