// Wire types for the Go admin API (/admin/api/*). Copied from the research TypeScript blocks:
// area-auth-global.md §2, area-accounts.md §2, area-observe-api.md §2 and
// area-settings-backups.md §2, de-duplicated. Names match the research unless noted.

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

/** Error body of every non-2xx admin response. `index` comes with model-mapping 400s. */
export interface ApiErrorBody {
  error: string;
  /** Stable machine code on some errors (see ServerErrorCode); match on it, not on `error`. */
  code?: ServerErrorCode | (string & {});
  /** 0-based index in the submitted model-mapping array; -1 = the whole list. */
  index?: number;
  success?: false;
}

export interface SuccessResponse {
  success: true;
}

/**
 * Codes the server sends in ApiErrorBody.code.
 * - api_key_lockout (409): the change would leave requireApiKey on with no enabled key.
 * - backup_not_found (404): unknown backup id.
 * - backup_* (400): an upload or stored backup the restore cannot read.
 * - invalid_cadence / invalid_keep (400): POST /backups/schedule out of range.
 */
export type ServerErrorCode =
  | "api_key_lockout"
  | "backup_not_found"
  | "backup_invalid_json"
  | "backup_unsupported_format"
  | "backup_unsupported_version"
  | "backup_schema_mismatch"
  | "invalid_cadence"
  | "invalid_keep";

// ---------------------------------------------------------------------------
// Session and first run
// ---------------------------------------------------------------------------

export interface SessionCreateRequest {
  password: string;
}
export interface SessionCreateResponse {
  token: string;
  /** ms epoch, about now + 12 h */
  expiresAt: number;
}
export type SessionDeleteResponse = SuccessResponse;
export interface SessionTicketResponse {
  ticket: string;
  /** ms epoch, about now + 30 s */
  expiresAt: number;
}
export interface FirstRunResponse {
  /** "" when first run is not pending */
  password: string;
}
// 429 on POST /session or any X-Admin-Password call: ApiErrorBody + Retry-After header (seconds).

// ---------------------------------------------------------------------------
// SSE (/admin/api/events)
// ---------------------------------------------------------------------------

/**
 * Events the server emits. The dead `account_updated` / `accounts_refreshed` are dropped.
 * Change events carry the changed row's id as `payload`, or "*" for many (none for settings
 * and stats): accounts_changed comes from every account write, background bans and cooldowns
 * included; backup_deleted also fires with "*" when lowering `keep` prunes scheduled backups.
 */
export type AdminEventType =
  | "hello"
  | "observe_tick"
  | "backup_created"
  | "backup_restored"
  | "backup_deleted"
  | "accounts_changed"
  | "api_keys_changed"
  | "settings_changed"
  | "stats_reset";
export interface AdminEventData {
  type: AdminEventType;
  payload?: string;
}

// ---------------------------------------------------------------------------
// Stats, status, version, machine id
// ---------------------------------------------------------------------------

/** GET /admin/api/stats and GET /v1/stats */
export interface StatsResponse {
  status: "ok";
  version: string;
  accounts: number;
  available: number;
  accountCreditsUsed: number;
  accountCreditsLimit: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  totalTokens: number;
  totalCredits: number;
  successTokens: number;
  successInTokens: number;
  successOutTokens: number;
  successCredits: number;
  totalErrorEvents: number;
  /** seconds */
  uptime: number;
}
/** GET /admin/api/status (what the UI polls) */
export interface StatusResponse extends StatsResponse {
  totalBanned: number;
  todayBanned: number;
  totalExhausted: number;
}
/** POST /admin/api/stats/reset */
export type StatsResetResponse = SuccessResponse;

export interface VersionResponse {
  version: string;
}
export interface MachineIdResponse {
  machineId: string;
}
/** raw.githubusercontent.com/.../version.json */
export interface RemoteVersionJson {
  version: string;
  changelog?: string;
  download?: string;
}

// ---------------------------------------------------------------------------
// Add-account flows (shared)
// ---------------------------------------------------------------------------

export interface AddedAccountRef {
  id: string;
  email: string;
}
export interface AddAccountResponse {
  success: true;
  account: AddedAccountRef;
}

// IAM SSO
export interface IamSsoStartRequest {
  startUrl: string;
  region?: string;
}
export interface IamSsoStartResponse {
  sessionId: string;
  authorizeUrl: string;
  expiresIn: number;
}
export interface IamSsoCompleteRequest {
  sessionId: string;
  callbackUrl: string;
}
export type IamSsoCompleteResponse = AddAccountResponse;

// Microsoft SSO
export type MicrosoftStage = "kiro" | "microsoft" | "profile" | "complete";
export interface MicrosoftStartResponse {
  sessionId: string;
  authorizeUrl: string;
  expiresIn: number;
  stage: "kiro";
}
export interface MicrosoftCompleteRequest {
  sessionId: string;
  callbackUrl: string;
}
export interface KiroProfile {
  arn: string;
  name?: string;
  region: string;
}
export type MicrosoftCompleteResponse =
  | { success: true; stage: "microsoft"; authorizeUrl: string }
  | { success: true; stage: "profile"; selectionId: string; profiles: KiroProfile[] }
  | { success: true; stage: "complete"; account: AddedAccountRef; warning?: string };
export interface MicrosoftSelectProfileRequest {
  selectionId: string;
  profileArn: string;
}
export type MicrosoftSelectProfileResponse = Extract<
  MicrosoftCompleteResponse,
  { stage: "complete" }
>;
export interface MicrosoftCancelRequest {
  sessionId?: string;
  selectionId?: string;
}
export type MicrosoftCancelResponse = SuccessResponse;

// BuilderID device code
export interface BuilderIdStartRequest {
  region?: string;
}
export interface BuilderIdStartResponse {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}
export interface BuilderIdPollRequest {
  sessionId: string;
}
export type BuilderIdPollResponse =
  | { success: true; completed: false; status: "pending" | "slow_down"; interval: number }
  | { success: true; completed: true; account: AddedAccountRef };
/** HTTP 400 */
export interface BuilderIdPollError {
  success: false;
  error: string;
}

// SSO token (bulk)
export interface SsoTokenImportRequest {
  /** newline-separated */
  bearerToken: string;
  region?: string;
}
export interface SsoTokenImportResponse {
  success: true;
  accounts: AddedAccountRef[];
  errors: string[] | null;
}
/** HTTP 500 */
export interface SsoTokenImportFailure {
  success: false;
  error: string;
}

// Credentials import
export interface CredentialsImportRequest {
  accessToken?: string;
  refreshToken?: string;
  kiroApiKey?: string;
  clientId?: string;
  clientSecret?: string;
  authMethod?: string;
  provider?: string;
  region?: string;
  email?: string;
  nickname?: string;
  userId?: string;
  profileArn?: string;
  tokenEndpoint?: string;
  issuerUrl?: string;
  scopes?: string;
}
export type CredentialsImportResponse = AddAccountResponse;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

// `(string & {})` keeps the known values in autocomplete while accepting any server string.
export type BanStatus = "" | "ACTIVE" | "BANNED" | "SUSPENDED" | (string & {});
/** Compare case-insensitively. */
export type OverageStatus = "" | "ENABLED" | "DISABLED" | (string & {});
export type AuthMethod =
  | "idc"
  | "social"
  | "builderid"
  | "external_idp"
  | "api_key"
  | "apikey"
  | "github"
  | "google"
  | (string & {});

/** Element of GET /accounts */
export interface Account {
  id: string;
  /** may be "" -> UI shows id.slice(0, 12) + '...' */
  email: string;
  userId: string;
  nickname: string;
  authMethod: AuthMethod;
  /** e.g. "Enterprise", "BuilderId", "Google", "Github", "APIKey", "Microsoft..." */
  provider: string;
  /** OAuth/OIDC region */
  region: string;
  profileArn: string;
  profileArnPinned: boolean;
  /** data-plane region (derived) */
  activeRegion: string;
  enabled: boolean;
  silent: boolean;
  silentReason: string;
  /** unix s */
  silentTime: number;
  banStatus: BanStatus;
  banReason: string;
  /** unix s */
  banTime: number;
  /** unix s; 0 = none/never (api_key) */
  expiresAt: number;
  hasToken: boolean;
  machineId: string;
  /** 0 = unset (effective weight 1) */
  weight: number;
  overageStatus: OverageStatus;
  /** 'NOT_OVERAGE_CAPABLE' | 'OVERAGE_CAPABLE' | '' */
  overageCapability: string;
  /** USD */
  overageCap: number;
  /** USD */
  overageRate: number;
  /** USD */
  currentOverages: number;
  /** unix s */
  overageCheckedAt: number;
  proxyURL: string;
  /** e.g. Q_DEVELOPER_STANDALONE_PRO / _POWER / _PRO_PLUS / FREE */
  subscriptionType: string;
  subscriptionTitle: string;
  daysRemaining: number;
  usageCurrent: number;
  usageLimit: number;
  /** FRACTION 0..1 */
  usagePercent: number;
  nextResetDate: string;
  /** unix s */
  lastRefresh: number;
  trialUsageCurrent: number;
  trialUsageLimit: number;
  /** FRACTION 0..1 */
  trialUsagePercent: number;
  /** 'ACTIVE' | ... */
  trialStatus: string;
  /** unix s */
  trialExpiresAt: number;
  // runtime stats from the pool
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  totalCredits: number;
  /** unix s */
  lastUsed: number;
}
export type AccountListResponse = Account[];

/** GET /accounts/{id}/full */
export interface AccountFull extends Omit<Account, "hasToken" | "activeRegion"> {
  accessToken: string;
  refreshToken: string;
  kiroApiKey: string;
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  issuerUrl: string;
  scopes: string;
}

/** POST /accounts (unused by the UI) */
export interface AddAccountRequest {
  id?: string;
  email?: string;
  userId?: string;
  nickname?: string;
  accessToken?: string;
  refreshToken?: string;
  kiroApiKey?: string;
  clientId?: string;
  clientSecret?: string;
  authMethod?: string;
  provider?: string;
  region?: string;
  startUrl?: string;
  expiresAt?: number;
  machineId?: string;
  profileArn?: string;
  tokenEndpoint?: string;
  issuerUrl?: string;
  scopes?: string;
  proxyURL?: string;
  weight?: number;
  /** defaults to false */
  enabled?: boolean;
}
/**
 * POST /accounts response. Research calls it `AddAccountResponse`; renamed because that name
 * belongs to the add-account flows (`{ success, account }`).
 */
export interface CreateAccountResponse {
  success: true;
  id: string;
}

/** PUT /accounts/{id} */
export interface UpdateAccountRequest {
  enabled?: boolean;
  nickname?: string;
  machineId?: string;
  weight?: number;
  proxyURL?: string;
  silent?: boolean;
  silentReason?: string;
}

/** POST /accounts/batch */
export type BatchAction = "enable" | "disable" | "refresh" | "refreshModels" | "delete";
export interface BatchAccountsRequest {
  ids: string[];
  action: BatchAction;
}
/**
 * One requested id's outcome, in request order (duplicates dropped). `status` is "not_found"
 * for an unknown id, and "suspended" (with ok:true) when a refresh found the account suspended
 * and marked it.
 */
export interface AccountActionResult {
  id: string;
  ok: boolean;
  error?: string;
  status?: "not_found" | "suspended";
}
export interface BatchEnableDisableResponse {
  success: true;
  /** accounts saved; unknown ids are not counted */
  count: number;
  /** unknown ids plus save failures */
  failed: number;
  results: AccountActionResult[];
}
export interface BatchRefreshResponse {
  success: true;
  refreshed: number;
  /** marked suspended instead of refreshed */
  suspended: number;
  failed: number;
  results: AccountActionResult[];
}
export interface BatchRefreshModelsResponse {
  success: true;
  /** accounts whose model list was refreshed */
  refreshed: number;
  failed: number;
  /** distinct models cached across all accounts afterwards */
  models: number;
  results: AccountActionResult[];
}
export interface BatchDeleteResponse {
  success: true;
  deleted: number;
  failed: number;
  results: AccountActionResult[];
}
export type BatchAccountsResponse =
  | BatchEnableDisableResponse
  | BatchRefreshResponse
  | BatchRefreshModelsResponse
  | BatchDeleteResponse;

/** POST /accounts/{id}/refresh. PascalCase: the Go struct has no json tags. */
export interface AccountInfo {
  Email: string;
  UserId: string;
  SubscriptionType: string;
  SubscriptionTitle: string;
  DaysRemaining: number;
  UsageCurrent: number;
  UsageLimit: number;
  UsagePercent: number;
  NextResetDate: string;
  LastRefresh: number;
  TrialUsageCurrent: number;
  TrialUsageLimit: number;
  TrialUsagePercent: number;
  TrialStatus: string;
  TrialExpiresAt: number;
}
export type RefreshAccountResponse =
  | { success: true; info: AccountInfo }
  | { success: true; message: "Account status updated"; info?: undefined };

/** POST /accounts/{id}/test */
export interface TestAccountRequest {
  model?: string;
}
export interface TestAccountResponse {
  success: true;
  reply: string;
  model: string;
  stopReason: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  /** percent */
  contextUsage: number;
}

// Models
export interface ModelInfo {
  modelId: string;
  modelName: string;
  description: string;
  supportedInputTypes: string[];
  rateMultiplier: number;
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
  tokenLimits: { maxInputTokens: number; maxOutputTokens: number } | null;
}
export interface AccountModelsResponse {
  success: true;
  models: ModelInfo[];
}
export interface AccountModelsCachedResponse {
  success: true;
  models: string[];
}
export interface RefreshAccountModelsResponse {
  success: true;
  count: number;
}
/** POST /accounts/models/refresh: one sweep over every enabled account. */
export interface RefreshAllModelsResponse {
  success: true;
  /** enabled accounts the sweep visited */
  accounts: number;
  /** accounts whose model list was refreshed */
  refreshed: number;
  failed: number;
  /** distinct models cached afterwards */
  models: number;
  results: AccountActionResult[];
}

// Overage
export interface OverageResponse {
  success: true;
  overageStatus: OverageStatus;
  overageCapability: string;
  subscriptionTitle: string;
  overageCap: number;
  overageRate: number;
  currentOverages: number;
  overageCheckedAt: number;
}
export interface SetOverageRequest {
  enabled: boolean;
}

// Profiles
export interface AccountProfile {
  arn: string;
  name: string;
  region: string;
  current: boolean;
}
export interface AccountProfilesResponse {
  success: true;
  profiles: AccountProfile[];
  currentArn: string;
  activeRegion: string;
  pinned: boolean;
}
/** profileArn '' = unpin */
export interface SetAccountProfileRequest {
  profileArn: string;
}
export type SetAccountProfileResponse =
  | { success: true; pinned: false }
  | { success: true; pinned: true; profileArn: string; region: string };

// ---------------------------------------------------------------------------
// Export (POST /admin/api/export)
// ---------------------------------------------------------------------------

export interface ExportRequest {
  ids?: string[];
}
export interface ExportCredentials {
  accessToken: string;
  csrfToken: string;
  refreshToken: string;
  kiroApiKey?: string;
  clientId?: string;
  clientSecret?: string;
  region?: string;
  /** ms */
  expiresAt: number;
  authMethod?: string;
  provider?: string;
  tokenEndpoint?: string;
  issuerUrl?: string;
  scopes?: string;
}
export interface ExportAccount {
  id: string;
  email: string;
  nickname?: string;
  idp: string;
  userId?: string;
  profileArn?: string;
  machineId?: string;
  credentials: ExportCredentials;
  subscription: { type: "Free" | "Pro" | "Pro_Plus"; title?: string };
  /** lastUpdated in ms */
  usage: { current: number; limit: number; percentUsed: number; lastUpdated: number };
  tags: string[];
  status: "active";
  /** ms */
  createdAt: number;
  /** ms */
  lastUsedAt: number;
}
/** Export file body. Research also calls it `ExportResponse`. */
export interface ExportData {
  version: string;
  /** ms */
  exportedAt: number;
  accounts: ExportAccount[];
  groups: unknown[];
  tags: unknown[];
}

// ---------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------

/** GET /admin/api/observe/overview */
export interface ObserveOverview {
  /** unix s */
  startedAt: number;
  /** unix s */
  nowUnix: number;
  /** requests in the current partial minute */
  rpm1: number;
  /** requests/min over the last 5 buckets */
  rpm5Avg: number;
  /** 0..1 ratio */
  errRate5: number;
  inTpm5: number;
  outTpm5: number;
  credits5: number;
  credits60: number;
  errors60: number;
  successes60: number;
  activeAccts: number;
  /** accounts with traffic rings, not configured accounts */
  totalAccts: number;
  totalModels: number;
}
export interface HeatmapCell {
  /** 0 = current minute, N = N minutes ago */
  offset: number;
  reqs: number;
  failures: number;
  /** omitted when 0 */
  credits?: number;
}
export interface AccountHeatmap {
  /** "_global_" for the global row */
  accountId: string;
  /** never set on global; omitted if the account is missing */
  email?: string;
  /** length === windowMin */
  cells: HeatmapCell[];
}
/** GET /admin/api/observe/account-heatmap?windowMin= */
export interface HeatmapResponse {
  /** 1..1440 */
  windowMin: number;
  nowUnix: number;
  global: AccountHeatmap;
  /** null when there is no traffic */
  accounts: AccountHeatmap[] | null;
}
export interface ModelMixEntry {
  model: string;
  reqs: number;
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  /** unix s */
  lastUsed: number;
}
/** sorted by credits desc */
export interface ModelMixResponse {
  models: ModelMixEntry[];
}

export interface ObserveError {
  /** unix s */
  ts: number;
  accountId: string;
  email?: string;
  model?: string;
  status?: number;
  /** <= 240 chars */
  message?: string;
}
/** newest first, max 100 */
export interface RecentErrorsResponse {
  errors: ObserveError[];
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type RequestEndpoint = "claude" | "openai" | "responses";
export type RequestErrorType =
  | "client_closed"
  | "api_key_limit"
  | "overage"
  | "quota"
  | "suspended"
  | "profile"
  | "auth"
  | "stream"
  | "no_accounts"
  | "invalid_request"
  | "rate_limit"
  | "timeout"
  | "upstream"
  | "unknown";
export type RequestSort =
  | "time"
  | "status"
  | "account"
  | "api_key"
  | "model"
  | "tokens"
  | "credits"
  | "duration";

export interface RequestRecord {
  /** only when persistent */
  id?: number;
  /** unix s */
  ts: number;
  /** may be "" (auth failures before routing) */
  accountId: string;
  apiKeyId?: string;
  apiKeyMasked?: string;
  email?: string;
  /** may be "" */
  model: string;
  inTokens: number;
  outTokens: number;
  /** in + out (cache is a subset of in) */
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  success: boolean;
  status?: number;
  /** <= 500 chars */
  message?: string;
  endpoint?: RequestEndpoint;
  durationMs?: number;
  /** only when !success */
  errorType?: RequestErrorType;
}
export interface RecentRequestsParams {
  /** >= 1, default 1 */
  page?: number;
  /** default 25, clamp 200 (alias: limit) */
  pageSize?: number;
  search?: string;
  status?: "success" | "failed" | "";
  /** default 'time' */
  sort?: RequestSort;
  /** default 'desc' */
  order?: "asc" | "desc";
}
export interface RecentRequestsResponse {
  requests: RequestRecord[];
  total: number;
  page: number;
  pageSize: number;
  sort: RequestSort;
  order: "asc" | "desc";
  persistent: boolean;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/** apiKeyView */
export interface ApiKey {
  id: string;
  name?: string;
  /** ONLY on GET /api-keys/{id} */
  key?: string;
  keyMasked: string;
  enabled: boolean;
  /** unix s */
  createdAt: number;
  /** unix s, omitted when 0 */
  lastUsedAt?: number;
  /** int, omitted/0 = unlimited */
  tokenLimit?: number;
  /** omitted/0 = unlimited */
  creditLimit?: number;
  tokensUsed: number;
  creditsUsed: number;
  requestsCount: number;
}
export interface ApiKeyListResponse {
  apiKeys: ApiKey[];
}
export type ApiKeyDetailResponse = ApiKey & { key: string };
export interface ApiKeyCreateRequest {
  name?: string;
  /** blank => server generates sk-<64 hex> */
  key?: string;
  /** default true */
  enabled?: boolean;
  /** int >= 0 */
  tokenLimit?: number;
  /** >= 0 */
  creditLimit?: number;
}
export interface ApiKeyCreateResponse {
  success: true;
  id: string;
  /** full secret; GET /api-keys/{id} also returns it later */
  key: string;
  apiKey: ApiKey;
}
export interface ApiKeyUpdateRequest {
  name?: string;
  /** "" or omitted keeps the current key */
  key?: string;
  enabled?: boolean;
  tokenLimit?: number;
  creditLimit?: number;
}
export interface ApiKeyUpdateResponse {
  success: true;
  apiKey: ApiKey;
}
export type ApiKeyDeleteResponse = SuccessResponse;
export type ApiKeyResetUsageResponse = { success: true; apiKey?: ApiKey };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  requireApiKey: boolean;
  /** read-only */
  port: number;
  /** read-only */
  host: string;
  allowOverUsage: boolean;
  lenientStreamIntegrity: boolean;
  /** default true */
  sessionAffinity: boolean;
  autoContinue: boolean;
  /** 1..10, default 3 */
  autoContinueMax: number;
  /** default true */
  structuredToolHistory: boolean;
}
export interface SettingsPatch {
  requireApiKey?: boolean;
  /** >= 8 runes; empty string ignored by the server */
  password?: string;
  allowOverUsage?: boolean;
  lenientStreamIntegrity?: boolean;
  sessionAffinity?: boolean;
  autoContinue?: boolean;
  /** integer 1..10 */
  autoContinueMax?: number;
  structuredToolHistory?: boolean;
}

export type ThinkingFormat = "reasoning_content" | "thinking" | "think";
export interface ThinkingConfig {
  /** default '-thinking' */
  suffix: string;
  /** default 'reasoning_content' */
  openaiFormat: ThinkingFormat;
  /** default 'thinking' (the UI offers only 'thinking' | 'think') */
  claudeFormat: ThinkingFormat;
}
/** all three fields are written on every call */
export type ThinkingConfigUpdate = ThinkingConfig;

export interface ModelMappingRule {
  key: string;
  value: string;
}
export interface ModelMappingsResponse {
  mappings: ModelMappingRule[];
  defaults: ModelMappingRule[];
}
export interface ModelMappingsUpdate {
  mappings: ModelMappingRule[];
}

export type PreferredEndpoint = "auto" | "kiro" | "codewhisperer" | "amazonq";
export interface EndpointConfig {
  preferredEndpoint: PreferredEndpoint;
  endpointFallback: boolean;
}
export interface EndpointConfigUpdate {
  preferredEndpoint: PreferredEndpoint;
  endpointFallback?: boolean;
}

/** '' | http(s)://[u[:p]@]host:port | socks5(h)://... */
export interface ProxyConfig {
  proxyURL: string;
}
export type ProxyConfigUpdate = ProxyConfig;

export type PromptFilterRuleType = "regex" | "lines-containing" | "contains";
export interface PromptFilterRule {
  /** the UI generates 'rule-' + Date.now() */
  id: string;
  name: string;
  /** the UI emits 'regex' | 'lines-containing' */
  type: PromptFilterRuleType;
  match: string;
  /** regex only; '' = remove matches */
  replace?: string;
  enabled: boolean;
}
export interface PromptFilterConfig {
  filterClaudeCode: boolean;
  filterEnvNoise: boolean;
  filterStripBoundaries: boolean;
  rules: PromptFilterRule[];
}
export type PromptFilterUpdate = Partial<PromptFilterConfig>;

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export type BackupKind = "manual" | "scheduled" | "auto" | "pre-restore" | (string & {});
export interface BackupEntry {
  id: string;
  /** unix seconds */
  createdAt: number;
  kind: BackupKind;
  note?: string;
  file: string;
  size: number;
  sha256: string;
  /** omitted when 0 */
  accountCnt?: number;
  /** pre-restore rows only */
  restoredAccountCnt?: number;
  version?: string;
  format?: string;
  includesCredentials?: boolean;
}
/** backups is null when empty */
export interface BackupListResponse {
  backups: BackupEntry[] | null;
}
export interface BackupListQuery {
  autoInclude?: "true";
}
export interface BackupCreateRequest {
  kind?: BackupKind;
  note?: string;
}
export interface BackupCreateResponse {
  backup: BackupEntry;
}
export interface BackupGetResponse {
  backup: BackupEntry;
}
export type BackupCadence = "hourly" | "daily" | "weekly";
export interface BackupSchedule {
  /** omitted when false */
  enabled?: boolean;
  /** omitted when unset */
  cadence?: BackupCadence;
  /** omitted when 0; server prune default 50, UI default 20 */
  keep?: number;
  /** unix seconds, read-only */
  lastRun?: number;
  /**
   * unix seconds, read-only: when the scheduler takes the next backup, max(lastRun + cadence,
   * now) rounded up to its 5-minute tick. Omitted while disabled.
   */
  nextRun?: number;
}
/** GET and POST /backups/schedule */
export interface BackupScheduleResponse {
  schedule: BackupSchedule;
}
/** 400 unless cadence is hourly|daily|weekly and keep is 1..200. Lowering keep prunes at once. */
export interface BackupScheduleUpdate {
  enabled: boolean;
  cadence: BackupCadence;
  keep: number;
}
/** Restore upload: multipart/form-data with field "file", or a raw JSON body. */
export interface BackupFile {
  format: "kiro-proxy-backup";
  version: 1;
  createdAt: number;
  /** full config.Config (accounts, password, port, host, ...) */
  config: Record<string, unknown>;
  credentialsLoaded: boolean;
  credentials?: Array<Record<string, unknown> & { id: string }>;
}

// ---------------------------------------------------------------------------
// Normalized types (what the endpoint functions return after cleaning the wire shape)
// ---------------------------------------------------------------------------

/** HeatmapResponse with `accounts` never null. */
export type HeatmapData = Omit<HeatmapResponse, "accounts"> & { accounts: AccountHeatmap[] };

/** SsoTokenImportResponse with `errors` never null. */
export type SsoTokenImportResult = Omit<SsoTokenImportResponse, "errors" | "accounts"> & {
  accounts: AddedAccountRef[];
  errors: string[];
};
