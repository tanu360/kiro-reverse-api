// Wire types for the Go admin API (/admin/api/*). Copied from the research TypeScript blocks:
// area-auth-global.md §2, area-accounts.md §2, area-observe-api.md §2 and
// area-settings-backups.md §2, de-duplicated. Names match the research unless noted.

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

export interface SuccessResponse {
  success: true;
}

/**
 * Codes the server sends in ApiErrorBody.code (proxy/admin_errors.go, auth/errors.go), next to
 * the English `error`. `detail` is upstream text shown after the translation; other string or
 * number fields fill its placeholders. Batch rows (AccountActionResult) carry the same codes.
 * - api_key_lockout (409): the change would leave requireApiKey on with no enabled key.
 * - backup_not_found (404): unknown backup id.
 * - backup_* (400): an upload or stored backup the restore cannot read (`detail`: why).
 * - invalid_cadence / invalid_keep (400): POST /backups/schedule out of range.
 * - token_refresh_failed, models_refresh_failed, overage_failed, profile_verify_failed,
 *   kiro_sign_in_failed, microsoft_denied, microsoft_token_failed, microsoft_credential_invalid,
 *   sso_* : `detail` is the upstream reason.
 * - callback_url_wrong_address: `expected` is the callback URL the step needs.
 * - model_*: also `index`; `model` (duplicate, self, chain) or `max` (too many, ID too long).
 */
export type ServerErrorCode =
  | "api_key_lockout"
  | "backup_not_found"
  | "backup_invalid_json"
  | "backup_unsupported_format"
  | "backup_unsupported_version"
  | "backup_schema_mismatch"
  | "backup_upload_failed"
  | "invalid_cadence"
  | "invalid_keep"
  | "invalid_json"
  | "account_not_found"
  | "api_key_not_found"
  | "no_account_ids"
  | "not_overage_capable"
  | "overage_failed"
  | "models_refresh_failed"
  | "invalid_region"
  | "start_url_required"
  | "bearer_token_required"
  | "refresh_token_required"
  | "kiro_api_key_empty"
  | "kiro_api_key_invalid"
  | "kiro_api_key_region"
  | "kiro_api_key_region_unsupported"
  | "kiro_api_key_duplicate"
  | "token_refresh_failed"
  | "profile_arn_invalid"
  | "profile_not_available"
  | "profile_verify_failed"
  | "no_kiro_profile"
  | "api_key_account_no_profile"
  | "auto_continue_max_range"
  | "password_too_short"
  | "invalid_endpoint"
  | "proxy_url_scheme"
  | "count_tokens_url_invalid"
  | "count_tokens_auth_type"
  | "count_tokens_key_invalid"
  | "api_key_empty"
  | "api_key_exists"
  | "api_key_collision"
  | "token_limit_negative"
  | "credit_limit_negative"
  | "model_mappings_too_many"
  | "model_mapping_empty"
  | "model_mapping_no_source"
  | "model_mapping_no_target"
  | "model_id_too_long"
  | "model_id_invalid_chars"
  | "model_mapping_self"
  | "model_mapping_duplicate"
  | "model_mapping_chain"
  | "sso_register_failed"
  | "sso_session_expired"
  | "sso_timeout"
  | "sso_denied"
  | "sso_check_failed"
  | "sso_state_mismatch"
  | "sso_no_code"
  | "invalid_callback_url"
  | "callback_url_wrong_address"
  | "kiro_sign_in_failed"
  | "microsoft_too_many_sessions"
  | "microsoft_not_enterprise"
  | "microsoft_canceled"
  | "microsoft_duplicate"
  | "microsoft_denied"
  | "microsoft_token_failed"
  | "microsoft_tenant_mismatch"
  | "microsoft_credential_invalid"
  | "microsoft_profile_unresolved";

// ---------------------------------------------------------------------------
// Session and first run
// ---------------------------------------------------------------------------

export interface SessionCreateResponse {
  token: string;
  /** ms epoch, about now + 12 h */
  expiresAt: number;
}
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
 * and stats):
 * - accounts_changed comes from every account write except the per-request stats counters,
 *   background bans included, and when a pool cooldown starts, grows or is cleared.
 * - backup_deleted also fires with "*" whenever a save of an enabled schedule pruned
 *   scheduled backups (not only when `keep` is lowered).
 * - observe_tick comes at most once a second, each time with a new payload: the store's change
 *   counter as a decimal string. It follows a store write, a minute ending while the last 24 h
 *   hold traffic (every window shifts), and a change in the enabled or available account count.
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

// ---------------------------------------------------------------------------
// Stats, status, version, machine id
// ---------------------------------------------------------------------------

/** GET /admin/api/stats and GET /v1/stats */
interface StatsResponse {
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
  | {
      success: true;
      stage: "complete";
      account: AddedAccountRef;
      /** English; `warningCode` (a ServerErrorCode) and `warningDetail` are what the UI shows. */
      warning?: string;
      warningCode?: ServerErrorCode;
      warningDetail?: string;
    };
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
 * and marked it. `error` is English; `code` and `detail`, when sent, are what the UI shows.
 */
export interface AccountActionResult {
  id: string;
  ok: boolean;
  error?: string;
  code?: ServerErrorCode;
  detail?: string;
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
export type SetAccountProfileResponse =
  | { success: true; pinned: false }
  | { success: true; pinned: true; profileArn: string; region: string };

// ---------------------------------------------------------------------------
// Export (POST /admin/api/export)
// ---------------------------------------------------------------------------

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

/**
 * Per-minute values for the last 30 minutes, oldest first; the last entry is the current,
 * partial minute. Taken from the global ring.
 */
export interface ObserveSeries {
  /** client requests per minute */
  rpm: number[];
  /** failed / requests per minute, 0..1 (0 for an empty minute) */
  errRate: number[];
  /** input tokens per minute */
  inTpm: number[];
  /** output tokens per minute */
  outTpm: number[];
  credits: number[];
}

/**
 * GET /admin/api/observe/overview. Request counts are final client requests, the rows the
 * request log keeps; `retries60` counts failed upstream attempts. The rings are rebuilt from
 * SQLite on start, so the windows survive a restart.
 */
export interface ObserveOverview {
  /** unix s, process start or last stats reset */
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
  /** failed client requests in the last hour */
  errors60: number;
  successes60: number;
  /** failed upstream attempts in the last hour (a request that failed over twice adds 2) */
  retries60: number;
  /** accounts with requests in the last 5 minutes */
  activeAccts: number;
  /** accounts with traffic rings, not configured accounts */
  totalAccts: number;
  totalModels: number;
  /** configured accounts that are enabled */
  enabledAccts: number;
  /** enabled accounts that are not banned, suspended or over their limit (unless overage or over-usage is allowed) */
  availableAccts: number;
  series: ObserveSeries;
}
export interface HeatmapCell {
  /** 0 = current minute (or bucket), N = N minutes (buckets) ago */
  offset: number;
  /** final client requests, success or failure */
  reqs: number;
  /** final client requests that failed */
  failures: number;
  /** failed upstream attempts; omitted when 0 */
  retries?: number;
  /** omitted when 0 */
  credits?: number;
}
export interface AccountHeatmap {
  /** "_global_" for the global row */
  accountId: string;
  /** never set on global; omitted if the account is missing */
  email?: string;
  /** one per bucket, offset 0 first; with sparse=1 on the wire, empty cells are left out */
  cells: HeatmapCell[];
}
/**
 * GET /admin/api/observe/account-heatmap?windowMin=&bucketMin=&scope=&top=&sparse=
 * Without the optional params the response is dense, per minute and lists every account.
 */
export interface HeatmapResponse {
  /** 1..1440 */
  windowMin: number;
  /** minutes per cell, 1 unless bucketMin was sent (older servers omit it) */
  bucketMin?: number;
  nowUnix: number;
  global: AccountHeatmap;
  /** left out with scope=global or when no account has traffic (older servers send null) */
  accounts?: AccountHeatmap[] | null;
  /** with top=N: busy accounts beyond the N returned */
  restCount?: number;
}
export interface ModelMixEntry {
  model: string;
  /** final client requests since the last stats reset */
  reqs: number;
  /** failed upstream attempts for this model (older servers omit it) */
  retries?: number;
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
export interface BackupCreateRequest {
  kind?: BackupKind;
  note?: string;
}
export interface BackupCreateResponse {
  backup: BackupEntry;
}
export type BackupCadence = "hourly" | "daily" | "weekly";
export interface BackupSchedule {
  /** omitted when false */
  enabled?: boolean;
  /** omitted when unset */
  cadence?: BackupCadence;
  /**
   * The keep the server applies: 50 when never set, and a legacy value above 200 as stored.
   * Older servers omit it when unset; read that as 50 too.
   */
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
  /**
   * POST only, on a 200: the schedule was saved, but pruning old scheduled backups failed. The
   * next save of an enabled schedule, or its next run, retries the prune.
   */
  pruneError?: string;
}
/**
 * 400 unless cadence is hourly|daily|weekly and keep is 1..200, or equals the stored keep (a
 * legacy value above 200 sent back unchanged). Saving an enabled schedule prunes at once; a
 * disabled one never prunes.
 */
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

/**
 * HeatmapResponse with `accounts` always an array and every row dense: one cell per bucket,
 * offset 0 first, even when the wire was sparse. getAccountHeatmap always sets `bucketMin`.
 */
export type HeatmapData = Omit<HeatmapResponse, "accounts"> & { accounts: AccountHeatmap[] };

/** SsoTokenImportResponse with `errors` never null. */
export type SsoTokenImportResult = Omit<SsoTokenImportResponse, "errors" | "accounts"> & {
  accounts: AddedAccountRef[];
  errors: string[];
};
