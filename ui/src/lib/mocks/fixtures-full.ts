import type {
  Account,
  AccountFull,
  ApiKey,
  BackupEntry,
  BackupSchedule,
  EndpointConfig,
  ModelMappingRule,
  ObserveError,
  PromptFilterConfig,
  ProxyConfig,
  RequestEndpoint,
  RequestErrorType,
  RequestRecord,
  Settings,
  ThinkingConfig,
} from "@/lib/api/types";
import {
  backupId,
  base64ish,
  createRng,
  DEFAULT_PROFILE,
  defaultModelMappings,
  hashSeed,
  hex,
  int,
  MS_PROFILE_PRIMARY,
  MS_PROFILE_SANDBOX,
  makeAccount,
  makeAccountFull,
  makeBackupEntry,
  makeObserveError,
  makeRequestRecord,
  manualNote,
  maskKey,
  nextResetDate,
  pick,
  type Rng,
  round,
  seedAccounts,
  uuid,
  weighted,
} from "./fixtures";

// The "full" browser dataset (?mock=full, the dev server default): a realistic, polished fleet
// for demos and screenshots (believable names, mostly healthy accounts, a few in every state the
// Go server can report), at a realistic volume. Unit tests never load it; they keep the small seed
// in fixtures.ts. Every generator draws from its own fixed-seed PRNG, so the data is the same on
// every load; times are relative to "now".

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WINDOW_DAYS = 30;
const ACCOUNT_COUNT = 120;

type StoredKey = ApiKey & { key: string };

interface FullDataset {
  accounts: Account[];
  secrets: Record<string, AccountFull>;
  apiKeys: StoredKey[];
  /** newest first, persisted ids */
  requests: RequestRecord[];
  errors: ObserveError[];
  backups: BackupEntry[];
  schedule: BackupSchedule;
  settings: Settings;
  thinking: ThinkingConfig;
  modelMappings: ModelMappingRule[];
  endpoint: EndpointConfig;
  proxy: ProxyConfig;
  promptFilter: PromptFilterConfig;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** id, credit multiplier, share of traffic. Thinking variants and `auto` included. */
const MODELS: ReadonlyArray<readonly [string, number, number]> = [
  ["claude-sonnet-5", 1.3, 30],
  ["claude-haiku-4.5", 0.4, 18],
  ["claude-opus-5", 2.2, 10],
  ["claude-sonnet-4.6", 1, 10],
  ["claude-sonnet-4.5", 1, 7],
  ["claude-opus-4.8", 2.2, 5],
  ["claude-opus-4.6", 2.2, 4],
  ["auto", 1, 5],
  ["claude-sonnet-5-thinking", 1.3, 4],
  ["claude-opus-4.7", 2.2, 2],
  ["claude-opus-5-thinking", 2.2, 2],
  ["claude-sonnet-4.5-thinking", 1, 1.5],
  ["claude-haiku-5", 0.5, 1],
];
const MODEL_WEIGHTS = MODELS.map(([id, , share]) => [id, share] as const);
const MODEL_RATES = new Map(MODELS.map(([id, rate]) => [id, rate]));
/** The model of the one very large request in the log. */
const LONG_MODEL = "claude-sonnet-4.6";

const ENDPOINT_WEIGHTS: ReadonlyArray<readonly [RequestEndpoint, number]> = [
  ["claude", 55],
  ["openai", 28],
  ["responses", 17],
];

function credits(
  model: string,
  inTokens: number,
  outTokens: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const rate = MODEL_RATES.get(model) ?? 1;
  const value =
    ((inTokens - cacheRead * 0.9 + cacheWrite * 0.25) / 100_000 + outTokens / 20_000) * rate;
  return Math.max(0.0001, round(value, 4));
}

/** Log-normal draw clamped to [min, max]. */
function logNormal(rng: Rng, mu: number, sigma: number, min: number, max: number): number {
  const u = Math.max(rng(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  return Math.min(max, Math.max(min, Math.round(Math.exp(mu + sigma * z))));
}

function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Weighted picks in O(log n), for the request loop. */
function weightedIndex<T>(items: readonly T[], weight: (item: T) => number) {
  const cumulative: number[] = [];
  let total = 0;
  for (const item of items) {
    total += Math.max(0, weight(item));
    cumulative.push(total);
  }
  return (rng: Rng): T | undefined => {
    if (total <= 0) return undefined;
    const roll = rng() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > roll) hi = mid;
      else lo = mid + 1;
    }
    return items[lo];
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

interface Plan {
  type: string;
  title: string;
  limit: number;
}
const FREE: Plan = { type: "Q_DEVELOPER_STANDALONE_FREE", title: "KIRO FREE", limit: 50 };
const PRO: Plan = { type: "Q_DEVELOPER_STANDALONE_PRO", title: "KIRO PRO", limit: 1000 };
const PRO_PLUS: Plan = {
  type: "Q_DEVELOPER_STANDALONE_PRO_PLUS",
  title: "KIRO PRO+",
  limit: 2000,
};
const POWER: Plan = { type: "Q_DEVELOPER_STANDALONE_POWER", title: "KIRO POWER", limit: 10_000 };
/** What proxy/kiro_api.go parseSubscriptionType stores after a refresh. */
const BARE_TYPE: Record<string, string> = {
  [FREE.type]: "FREE",
  [PRO.type]: "PRO",
  [PRO_PLUS.type]: "PRO_PLUS",
  [POWER.type]: "POWER",
};

/** The ban reasons the Go server writes (proxy/kiro_api.go, proxy/account_failover.go). */
const BAN_REASONS = [
  "AWS temporarily suspended - unusual user activity detected",
  "Authentication failed - token invalid or expired",
  "AccessDeniedException: account access has been revoked (403)",
];

const FIRST =
  "maya ethan sofia lucas amara noah isla leo zara mateo nina kai elena omar ava jonas lina arjun clara hugo yara theo mila ravi ines felix nora sami aria daniel".split(
    " ",
  );
const LAST =
  "chen patel novak rivera okafor laurent tanaka berg moreau ito costa haas ward lindqvist kapoor sato reyes hale fischer park adler quinn nakamura silva brooks vega marsh holm".split(
    " ",
  );
const COMPANY_DOMAINS =
  "northwind.studio lumen.ai orbitlabs.dev helix.health paperplane.co novadesign.io tidewater.dev brightline.app copperleaf.com atlasworks.io".split(
    " ",
  );
const PERSONAL_DOMAINS = "gmail.com icloud.com proton.me fastmail.com hey.com outlook.com".split(
  " ",
);
const AZURE_DOMAINS = [
  "northwind.onmicrosoft.com",
  "atlasworks.onmicrosoft.com",
  "helix.onmicrosoft.com",
];
const NICKNAMES =
  "Primary|Design team|Research|Night shift|EU traffic|Platform|Data science|Support|Growth|Mobile squad|Evaluations|Docs team|Infra|Prototyping|Backend|APAC|Frontend|Analytics|Billing|QA".split(
    "|",
  );
/** Labels for headless API-key accounts. */
const KEY_LABELS =
  "build-runner nightly-evals agent-fleet docs-bot review-bot batch-worker sandbox eval-harness".split(
    " ",
  );

type MailKind = "company" | "personal" | "azure" | "apikey";
interface AuthKind {
  authMethod: string;
  provider: string;
  mail: MailKind;
}
const AUTH_KINDS: ReadonlyArray<readonly [AuthKind, number]> = [
  [{ authMethod: "idc", provider: "Enterprise", mail: "company" }, 28],
  [{ authMethod: "idc", provider: "BuilderId", mail: "personal" }, 10],
  [{ authMethod: "builderid", provider: "BuilderId", mail: "personal" }, 6],
  [{ authMethod: "social", provider: "Google", mail: "personal" }, 18],
  [{ authMethod: "social", provider: "Github", mail: "personal" }, 14],
  [{ authMethod: "github", provider: "Github", mail: "personal" }, 2],
  [{ authMethod: "google", provider: "Google", mail: "personal" }, 2],
  [{ authMethod: "external_idp", provider: "AzureAD", mail: "azure" }, 9],
  [{ authMethod: "api_key", provider: "APIKey", mail: "apikey" }, 8],
  [{ authMethod: "apikey", provider: "APIKey", mail: "apikey" }, 2],
];

/** A few organisations' Kiro profiles, shared by their Enterprise accounts. */
function orgProfiles(rng: Rng): Array<{ arn: string; region: string }> {
  const regions = [
    "us-east-1",
    "us-east-1",
    "eu-central-1",
    "us-east-1",
    "eu-central-1",
    "us-east-1",
  ];
  return regions.map((region) => ({
    arn: `arn:aws:codewhisperer:${region}:${String(int(rng, 100_000_000_000, 999_999_999_999))}:profile/${base64ish(
      rng,
      12,
    )
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "Q")}`,
    region,
  }));
}

function emailFor(rng: Rng, mail: MailKind, used: Set<string>): string {
  if (mail === "apikey") {
    let label = `${pick(rng, KEY_LABELS)}-${int(rng, 1, 9)}`;
    for (let n = 2; used.has(label); n++) label = `${pick(rng, KEY_LABELS)}-${int(rng, 1, 9)}${n}`;
    used.add(label);
    return label;
  }
  const first = pick(rng, FIRST);
  const last = pick(rng, LAST);
  const domain =
    mail === "company"
      ? pick(rng, COMPANY_DOMAINS)
      : mail === "azure"
        ? pick(rng, AZURE_DOMAINS)
        : pick(rng, PERSONAL_DOMAINS);
  const local = weighted(rng, [
    [`${first}.${last}`, 7],
    [`${first[0]}${last}`, 3],
    [first, 1],
  ] as const);
  let email = `${local}@${domain}`;
  for (let n = 2; used.has(email); n++) email = `${local}${n}@${domain}`;
  used.add(email);
  return email;
}

function machineIdFor(rng: Rng): string {
  return weighted(rng, [
    [uuid(rng), 80],
    [hex(rng, 32), 15],
    ["", 5],
  ] as const);
}

function proxyFor(rng: Rng): string {
  return weighted(rng, [
    ["", 88],
    [`socks5://127.0.0.1:${int(rng, 1080, 1089)}`, 6],
    ["http://proxy.northwind.studio:3128", 6],
  ] as const);
}

/** Per-account traffic eligibility for the request generator. */
interface Traffic {
  account: Account;
  weight: number;
  /** unix s: no requests before */
  from: number;
  /** unix s: no requests after (ban, silence, last use); Infinity while serving */
  until: number;
}

function usage(rng: Rng, limit: number, overage: boolean) {
  const bucket = weighted(rng, [
    ["zero", 6],
    ["low", 34],
    ["mid", 26],
    ["warn", 16],
    ["danger", 8],
    ["full", 4],
    ["over", overage ? 6 : 0],
  ] as const);
  const fraction = {
    zero: 0,
    low: 0.01 + rng() * 0.49,
    mid: 0.5 + rng() * 0.2,
    warn: 0.7 + rng() * 0.2,
    danger: 0.9 + rng() * 0.099,
    full: 1,
    over: 1.01 + rng() * 0.6,
  }[bucket];
  const current = round(limit * fraction, 2);
  return { usageCurrent: current, usagePercent: limit > 0 ? round(current / limit, 4) : 0 };
}

function randomAccount(
  rng: Rng,
  now: number,
  index: number,
  used: Set<string>,
  profiles: Array<{ arn: string; region: string }>,
): Account {
  const kind = weighted(rng, AUTH_KINDS);
  const apiKey = kind.mail === "apikey";
  const azure = kind.authMethod === "external_idp";
  const enterprise = kind.authMethod === "idc" && kind.provider === "Enterprise";
  const reset = nextResetDate();
  const daysToReset = Math.max(0, Math.ceil((Date.parse(`${reset}T00:00:00Z`) / 1000 - now) / DAY));

  // Region and profile
  let region = "us-east-1";
  let profileArn = "";
  let activeRegion = "us-east-1";
  if (apiKey) {
    region = weighted(rng, [
      ["us-east-1", 7],
      ["eu-central-1", 3],
    ] as const);
    activeRegion = region;
  } else if (azure) {
    profileArn = rng() < 0.75 ? MS_PROFILE_PRIMARY : MS_PROFILE_SANDBOX;
    activeRegion = profileArn === MS_PROFILE_PRIMARY ? "eu-central-1" : "us-east-1";
  } else if (enterprise) {
    region = weighted(rng, [
      ["us-east-1", 55],
      ["eu-central-1", 15],
      ["us-west-2", 12],
      ["ap-southeast-2", 10],
      ["eu-west-1", 8],
    ] as const);
    const profile = pick(rng, profiles);
    profileArn = profile.arn;
    activeRegion = profile.region;
  } else {
    profileArn = DEFAULT_PROFILE;
  }

  // Plan, usage and overage
  const plan = apiKey
    ? null
    : weighted(rng, [
        [FREE, 30],
        [PRO, 32],
        [PRO_PLUS, 18],
        [POWER, 12],
        [null, 4],
      ] as const);
  const capable = plan && plan !== FREE ? rng() < 0.85 : false;
  const overageCapability = !plan
    ? ""
    : capable
      ? "OVERAGE_CAPABLE"
      : rng() < 0.7
        ? "NOT_OVERAGE_CAPABLE"
        : "";
  const overageStatus = capable
    ? weighted(rng, [
        ["ENABLED", 35],
        ["DISABLED", 45],
        ["", 20],
      ] as const)
    : overageCapability === "NOT_OVERAGE_CAPABLE" && rng() < 0.4
      ? "DISABLED"
      : "";
  const limit = plan?.limit ?? 0;
  const { usageCurrent, usagePercent } = plan
    ? usage(rng, limit, overageStatus === "ENABLED")
    : { usageCurrent: 0, usagePercent: 0 };
  const overageCap = capable ? pick(rng, [0, 20, 50, 100, 250, 500, 1000, 5000]) : 0;
  const overageRate = capable ? 0.04 : 0;
  const overCredits = Math.max(0, usageCurrent - limit);
  const currentOverages = capable ? round(overCredits * overageRate, 2) : 0;
  const trial = plan === FREE && rng() < 0.3;

  // Health
  // A healthy fleet for screenshots: nine in ten serving, a handful in each other state.
  const health = weighted(rng, [
    ["healthy", 91],
    ["cleared", 4],
    ["expired", 2.5],
    ["banned", 0.2],
    ["suspended", 0.3],
    ["disabledBan", 0.2],
    ["adminOff", 1],
    ["silent", 0.8],
    ["noToken", 0],
  ] as const);
  const tier = weighted(rng, [
    ["heavy", 16],
    ["medium", 34],
    ["light", 32],
    ["dormant", 12],
    ["never", 6],
  ] as const);
  const requestCount = {
    heavy: int(rng, 20_000, 400_000),
    medium: int(rng, 2_000, 50_000),
    light: int(rng, 10, 2_000),
    dormant: int(rng, 1, 500),
    never: 0,
  }[tier];
  let lastUsed = {
    heavy: now - int(rng, 0, 90),
    medium: now - int(rng, 30, 1800),
    light: now - int(rng, HOUR, 5 * DAY),
    dormant: now - int(rng, 8 * DAY, 120 * DAY),
    never: 0,
  }[tier];

  const banTime = now - int(rng, 10 * MINUTE, 25 * DAY);
  const offline = ["banned", "suspended", "disabledBan", "adminOff", "silent"].includes(health);
  if (offline && lastUsed > banTime) lastUsed = requestCount > 0 ? banTime - int(rng, 1, 600) : 0;

  const errorRate = offline ? 0.05 + rng() * 0.3 : rng() * 0.02;
  const tokensPerRequest = int(rng, 4_000, 40_000);
  const totalTokens = requestCount * tokensPerRequest;

  const expiresAt = apiKey
    ? 0
    : health === "expired"
      ? now -
        weighted(rng, [
          [int(rng, 60, 3600), 4],
          [int(rng, HOUR, DAY), 3],
          [int(rng, DAY, 60 * DAY), 3],
        ] as const)
      : now +
        weighted(rng, [
          [int(rng, 10 * MINUTE, 59 * MINUTE), 60],
          [int(rng, 30, 9 * MINUTE), 15],
          [int(rng, HOUR, 11 * HOUR), 10],
          [int(rng, 2 * DAY, 30 * DAY), 3],
        ] as const);

  const email = emailFor(rng, kind.mail, used);
  return makeAccount({
    id: uuid(createRng(9500 + index)),
    email,
    userId: apiKey
      ? ""
      : kind.authMethod === "idc" || azure
        ? `d-${hex(rng, 10)}.${uuid(rng)}`
        : `${activeRegion}:${uuid(rng)}`,
    nickname: rng() < 0.3 ? pick(rng, NICKNAMES) : "",
    authMethod: kind.authMethod,
    provider: kind.provider,
    region,
    profileArn,
    profileArnPinned: !apiKey && (azure ? rng() < 0.6 : rng() < 0.12),
    activeRegion,
    enabled: !offline,
    silent: health === "silent",
    silentReason:
      health === "silent"
        ? pick(rng, ["manual", "quota exhausted, paused until reset", "rotating credentials"])
        : "",
    silentTime: health === "silent" ? banTime : 0,
    banStatus:
      health === "banned"
        ? "BANNED"
        : health === "suspended"
          ? "SUSPENDED"
          : health === "disabledBan"
            ? "DISABLED"
            : health === "cleared"
              ? "ACTIVE"
              : "",
    banReason:
      health === "banned"
        ? pick(rng, BAN_REASONS)
        : health === "suspended"
          ? "TEMPORARILY_SUSPENDED"
          : "",
    banTime: ["banned", "suspended", "disabledBan"].includes(health) ? banTime : 0,
    expiresAt,
    hasToken: health !== "noToken",
    machineId: machineIdFor(rng),
    weight: weighted(rng, [
      [0, 80],
      [int(rng, 1, 5), 14],
      [int(rng, 6, 20), 5],
      [100, 1],
    ] as const),
    // From the index, not the rng, so every other generated value stays the same. Ties included.
    priority: index % 5,
    overageStatus,
    overageCapability,
    overageCap,
    overageRate,
    currentOverages,
    overageCheckedAt: plan && rng() < 0.85 ? now - int(rng, 60, 3 * DAY) : 0,
    proxyURL: proxyFor(rng),
    subscriptionType: plan ? (rng() < 0.25 ? BARE_TYPE[plan.type] : plan.type) : "",
    subscriptionTitle: plan?.title ?? "",
    daysRemaining: plan ? daysToReset : 0,
    usageCurrent,
    usageLimit: limit,
    usagePercent,
    nextResetDate: plan ? reset : "",
    lastRefresh: plan ? now - int(rng, 60, 2 * DAY) : apiKey ? now - int(rng, 60, DAY) : 0,
    trialStatus: trial ? (rng() < 0.7 ? "ACTIVE" : "EXPIRED") : "",
    trialUsageCurrent: trial ? round(rng() * 500, 2) : 0,
    trialUsageLimit: trial ? 500 : 0,
    trialUsagePercent: 0,
    trialExpiresAt: trial ? now + int(rng, -10 * DAY, 25 * DAY) : 0,
    requestCount,
    errorCount: Math.round(requestCount * errorRate),
    totalTokens,
    totalCredits: round((totalTokens / 100_000) * (0.6 + rng() * 0.9), 2),
    lastUsed,
  });
}

/** One healthy Enterprise PRO account; each edge case overrides what it tests. */
function edgeAccount(now: number, index: number, overrides: Partial<Account>): Account {
  const rng = createRng(9100 + index);
  return makeAccount({
    id: uuid(rng),
    machineId: uuid(rng),
    userId: `d-${hex(rng, 10)}.${uuid(rng)}`,
    authMethod: "idc",
    provider: "Enterprise",
    region: "us-east-1",
    activeRegion: "us-east-1",
    profileArn: DEFAULT_PROFILE,
    expiresAt: now + 40 * MINUTE,
    subscriptionType: PRO.type,
    subscriptionTitle: PRO.title,
    daysRemaining: 20,
    usageCurrent: 300,
    usageLimit: 1000,
    usagePercent: 0.3,
    nextResetDate: nextResetDate(),
    lastRefresh: now - 15 * MINUTE,
    overageCapability: "OVERAGE_CAPABLE",
    overageStatus: "DISABLED",
    overageRate: 0.04,
    overageCap: 100,
    overageCheckedAt: now - HOUR,
    requestCount: 1200,
    errorCount: 14,
    totalTokens: 14_200_000,
    totalCredits: 182.4,
    lastUsed: now - 5 * MINUTE,
    ...overrides,
  });
}

/** Hand-made accounts for the values a random draw might miss. */
function edgeAccounts(now: number): Account[] {
  const cases: Array<Partial<Account>> = [
    {
      email: "zoe.lindqvist@copperleaf.com",
      nickname: "Dublin team",
      region: "eu-west-1",
      activeRegion: "eu-west-1",
    },
    { email: "noor.haddad@helix.health", nickname: "Support" },
    {
      email: "kai.tanaka@proton.me",
      nickname: "",
      authMethod: "social",
      provider: "Github",
      profileArn: DEFAULT_PROFILE,
    },
    { email: "archive@atlasworks.io", authMethod: "", provider: "", subscriptionType: "" },
    { email: "ines.moreau@brightline.app", authMethod: "saml", provider: "Okta" },
    {
      email: "finance@copperleaf.com",
      subscriptionType: "Q_DEVELOPER_ENTERPRISE_CUSTOM",
      subscriptionTitle: "KIRO ENTERPRISE (custom contract)",
      usageCurrent: 41_250,
      usageLimit: 50_000,
      usagePercent: 0.825,
    },
    {
      email: "lucas.rivera@paperplane.co",
      nickname: "Growth",
      overageStatus: "ENABLED",
      usageCurrent: 1240,
      usagePercent: 1.24,
      overageCap: 10,
      currentOverages: 9.6,
    },
    {
      email: "ava.chen@lumen.ai",
      overageStatus: "ENABLED",
      usageCurrent: 1500,
      usagePercent: 1.5,
      overageCap: 20,
      currentOverages: 20,
    },
    {
      email: "omar.haas@orbitlabs.dev",
      overageStatus: "ENABLED",
      subscriptionType: POWER.type,
      subscriptionTitle: POWER.title,
      usageCurrent: 12_625,
      usageLimit: 10_000,
      usagePercent: 1.2625,
      overageCap: 100,
      currentOverages: 105,
    },
    { email: "nina.berg@tidewater.dev", overageStatus: "enabled" },
    {
      email: "theo.ward@novadesign.io",
      subscriptionType: "POWER",
      subscriptionTitle: POWER.title,
      usageCurrent: 10_000,
      usageLimit: 10_000,
      usagePercent: 1,
      overageStatus: "DISABLED",
    },
    {
      email: "platform@northwind.studio",
      nickname: "Platform",
      subscriptionType: POWER.type,
      subscriptionTitle: POWER.title,
      usageCurrent: 9_412.37,
      usageLimit: 10_000,
      usagePercent: 0.9412,
      weight: 100,
      requestCount: 482_139,
      errorCount: 2_114,
      totalTokens: 3_912_441_208,
      totalCredits: 12_843.72,
      lastUsed: now - 2,
    },
    {
      email: "mila.adler@hey.com",
      requestCount: 1,
      errorCount: 0,
      totalTokens: 3,
      totalCredits: 0.0001,
      lastUsed: now - 9 * DAY,
      usageCurrent: 0.0001,
      usagePercent: 0.0000001,
    },
    {
      email: "felix.quinn@fastmail.com",
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      totalCredits: 0,
      lastUsed: 0,
      lastRefresh: 0,
      subscriptionType: "",
      subscriptionTitle: "",
      usageCurrent: 0,
      usageLimit: 0,
      usagePercent: 0,
      nextResetDate: "",
      daysRemaining: 0,
      overageCapability: "",
      overageStatus: "",
      overageCap: 0,
      overageRate: 0,
      overageCheckedAt: 0,
    },
    { email: "sami.reyes@brightline.app", expiresAt: now + 45 },
    { email: "clara.ito@brightline.app", expiresAt: now + 2 * MINUTE + 5 },
    {
      email: "daniel.park@northwind.onmicrosoft.com",
      authMethod: "external_idp",
      provider: "AzureAD",
      profileArn: MS_PROFILE_SANDBOX,
      profileArnPinned: true,
      expiresAt: now + 89 * DAY,
    },
    { email: "yara.costa@atlasworks.io", expiresAt: now - 61 },
    {
      email: "hugo.fischer@atlasworks.io",
      expiresAt: now - 400 * DAY,
      lastUsed: now - 400 * DAY,
      lastRefresh: now - 400 * DAY,
    },
    {
      email: "ravi.kapoor@gmail.com",
      enabled: false,
      banStatus: "BANNED",
      banReason: BAN_REASONS[0],
      banTime: now - 15 * MINUTE,
      lastUsed: now - 16 * MINUTE,
    },
    {
      email: "leo.marsh@outlook.com",
      enabled: false,
      banStatus: "SUSPENDED",
      banReason: "",
      banTime: now - 3 * DAY,
      lastUsed: now - 3 * DAY,
    },
    {
      email: "aria.vega@lumen.ai",
      banStatus: "ACTIVE",
      banReason: "",
      banTime: 0,
      nickname: "Research",
    },
    {
      email: "jonas.holm@copperleaf.com",
      enabled: false,
      banStatus: "DISABLED",
      banTime: now - 6 * HOUR,
      lastUsed: now - 6 * HOUR - 40,
    },
    {
      email: "isla.brooks@paperplane.co",
      enabled: false,
      silent: true,
      silentReason:
        "Paused by the on-call engineer while support looks into truncated replies on long tool-use conversations (INC-4821)",
      silentTime: now - 2 * HOUR,
      lastUsed: now - 2 * HOUR - 30,
    },
    {
      email: "agent-fleet-apac",
      nickname: "APAC",
      authMethod: "api_key",
      provider: "APIKey",
      region: "ap-southeast-1",
      activeRegion: "ap-southeast-1",
      profileArn: "",
      expiresAt: 0,
      subscriptionType: "",
      subscriptionTitle: "",
      usageCurrent: 0,
      usageLimit: 0,
      usagePercent: 0,
      nextResetDate: "",
      overageCapability: "",
      overageStatus: "",
      overageCap: 0,
      overageRate: 0,
      requestCount: 4_120,
      errorCount: 312,
    },
    {
      email: "batch-worker-eu",
      nickname: "EU traffic",
      authMethod: "apikey",
      provider: "APIKey",
      region: "eu-central-1",
      activeRegion: "eu-central-1",
      profileArn: "",
      expiresAt: 0,
      subscriptionType: PRO.type,
      subscriptionTitle: PRO.title,
    },
    {
      email: "zara.nakamura@gmail.com",
      authMethod: "social",
      provider: "Google",
      subscriptionType: FREE.type,
      subscriptionTitle: FREE.title,
      usageCurrent: 50,
      usageLimit: 50,
      usagePercent: 1,
      overageCapability: "NOT_OVERAGE_CAPABLE",
      overageStatus: "",
      trialStatus: "ACTIVE",
      trialUsageCurrent: 499.5,
      trialUsageLimit: 500,
      trialUsagePercent: 0.999,
      trialExpiresAt: now + 3 * HOUR,
    },
    {
      email: "ethan.hale@outlook.com",
      authMethod: "social",
      provider: "Github",
      subscriptionType: FREE.type,
      subscriptionTitle: FREE.title,
      usageCurrent: 12.3456,
      usageLimit: 50,
      usagePercent: 0.2469,
      overageCapability: "NOT_OVERAGE_CAPABLE",
      overageStatus: "",
      trialStatus: "EXPIRED",
      trialUsageCurrent: 500,
      trialUsageLimit: 500,
      trialUsagePercent: 1,
      trialExpiresAt: now - DAY,
    },
    {
      email: "elena.silva@icloud.com",
      authMethod: "builderid",
      provider: "BuilderId",
      subscriptionType: FREE.type,
      subscriptionTitle: FREE.title,
      usageCurrent: 0,
      usageLimit: 50,
      usagePercent: 0,
      trialStatus: "ACTIVE",
      trialUsageCurrent: 0,
      trialUsageLimit: 500,
      trialUsagePercent: 0,
      trialExpiresAt: now + 30 * DAY,
    },
    {
      email: "operations@helix.health",
      subscriptionType: "PRO_PLUS",
      subscriptionTitle: PRO_PLUS.title,
      usageCurrent: 1_624.5,
      usageLimit: 2_000,
      usagePercent: 0.81225,
    },
    {
      email: "noah.laurent@northwind.studio",
      profileArn: "",
      activeRegion: "",
      profileArnPinned: false,
    },
    { email: "maya.novak@paperplane.co", nickname: "Staging", enabled: false },
    { email: "kai.sato@novadesign.io", nextResetDate: "", daysRemaining: 0 },
    {
      email: "arjun.patel@lumen.ai",
      proxyURL: "socks5://proxy.lumen.ai:1080",
    },
    {
      email: "lina.okafor@proton.me",
      authMethod: "social",
      provider: "Google",
      enabled: false,
      banStatus: "BANNED",
      banReason: BAN_REASONS[1],
      banTime: now - 2 * DAY,
      subscriptionType: FREE.type,
      subscriptionTitle: FREE.title,
      usageCurrent: 50,
      usageLimit: 50,
      usagePercent: 1,
      lastUsed: now - 2 * DAY - 300,
    },
    {
      email: "mateo.chen@orbitlabs.dev",
      hasToken: false,
      expiresAt: 0,
      lastUsed: now - 4 * DAY,
    },
    // Auth methods the random draw makes rarely; stored by older imports.
    {
      email: "octavia.lee@proton.me",
      authMethod: "github",
      provider: "Github",
      userId: "us-east-1:5c2d7e0a-1b3f-4a8e-9d6c-0f1e2d3c4b5a",
      subscriptionType: FREE.type,
      subscriptionTitle: FREE.title,
      usageCurrent: 31.5,
      usageLimit: 50,
      usagePercent: 0.63,
      overageCapability: "NOT_OVERAGE_CAPABLE",
      overageStatus: "",
    },
    {
      email: "gwen.adler@gmail.com",
      authMethod: "google",
      provider: "Google",
      userId: "us-east-1:8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
    },
    {
      email: "nora.ward@hey.com",
      authMethod: "builderid",
      provider: "BuilderId",
      userId: "us-east-1:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    },
    {
      email: "eu-team@helix.health",
      region: "eu-central-1",
      activeRegion: "eu-central-1",
      profileArn: "arn:aws:codewhisperer:eu-central-1:381492027763:profile/EUENTERPRISE01",
      profileArnPinned: true,
      machineId: "",
    },
  ];
  return cases.map((overrides, index) => edgeAccount(now, index, overrides));
}

function trafficFor(account: Account, now: number, rng: Rng): Traffic {
  const offline =
    !account.enabled ||
    !account.hasToken ||
    (account.banStatus !== "" && account.banStatus !== "ACTIVE");
  const serving = !offline && account.lastUsed >= now - 30 * MINUTE;
  const offAt = account.banTime || account.silentTime || 0;
  let until = serving ? Number.POSITIVE_INFINITY : account.lastUsed;
  if (offAt) until = Math.min(until, offAt);
  return {
    account,
    // Busy accounts carry most of it, so the busiest few stand out in the per-account charts.
    weight: account.lastUsed > 0 ? (account.requestCount + 1) ** 1.25 : 0,
    from: rng() < 0.1 ? now - int(rng, DAY, 5 * DAY) : now - WINDOW_DAYS * DAY - DAY,
    until,
  };
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function apiKeysFull(now: number): StoredKey[] {
  const rng = createRng(5105);
  const sk = () => `sk-${hex(rng, 64)}`;
  const rows: Array<Partial<StoredKey> & { createdAt: number }> = [
    {
      name: "Production",
      createdAt: now - 41 * DAY,
      lastUsedAt: now - 5 * MINUTE,
      tokenLimit: 2_000_000,
      creditLimit: 50,
      tokensUsed: 1_874_210,
      creditsUsed: 46.2,
      requestsCount: 412,
    },
    {
      name: "Mobile app",
      createdAt: now - 17 * DAY,
      lastUsedAt: now - 40,
      tokensUsed: 523_118,
      creditsUsed: 18.4,
      requestsCount: 157,
    },
    {
      name: "CI pipeline",
      enabled: false,
      createdAt: now - 9 * DAY,
      lastUsedAt: now - 2 * DAY,
      tokenLimit: 500_000,
      tokensUsed: 500_412,
      creditsUsed: 9.87,
      requestsCount: 233,
    },
    { name: "Local dev", key: "kiro-dev-1", createdAt: now - 3 * DAY },
    {
      name: "Gateway — EU",
      createdAt: now - 380 * DAY,
      lastUsedAt: now - 1,
      tokensUsed: 941_200_833,
      creditsUsed: 18_244.27,
      requestsCount: 248_109,
    },
    {
      name: "Research",
      createdAt: now - 60 * DAY,
      lastUsedAt: now - 3 * MINUTE,
      creditLimit: 500,
      creditsUsed: 499.97,
      tokensUsed: 21_884_310,
      requestsCount: 9_120,
    },
    {
      name: "Data team",
      createdAt: now - 33 * DAY,
      lastUsedAt: now - 20 * MINUTE,
      tokenLimit: 100_000_000,
      tokensUsed: 95_120_448,
      creditsUsed: 1_422.5,
      requestsCount: 31_877,
    },
    {
      name: "Experiments",
      createdAt: now - 12 * DAY,
      lastUsedAt: now - 4 * HOUR,
      tokensUsed: 3_211_004,
      creditsUsed: 61.03,
      requestsCount: 1_480,
    },
    {
      name: "GitHub Actions",
      enabled: false,
      createdAt: now - 120 * DAY,
      lastUsedAt: now - 6 * DAY,
      creditLimit: 200,
      creditsUsed: 200.01,
      tokensUsed: 14_220_993,
      requestsCount: 6_602,
    },
    {
      name: "Jenkins",
      enabled: false,
      createdAt: now - 200 * DAY,
      lastUsedAt: now - 75 * DAY,
      tokensUsed: 812_330,
      creditsUsed: 14.2,
      requestsCount: 388,
    },
    {
      name: "Cursor",
      createdAt: now - 25 * DAY,
      lastUsedAt: now - 8,
      tokenLimit: 50_000_000,
      creditLimit: 1_000,
      tokensUsed: 12_004_551,
      creditsUsed: 233.18,
      requestsCount: 18_221,
    },
    {
      name: "Claude Code — laptop",
      createdAt: now - 14 * DAY,
      lastUsedAt: now - 30,
      tokensUsed: 288_114_902,
      creditsUsed: 4_120.66,
      requestsCount: 52_904,
    },
    {
      name: "Codex CLI",
      createdAt: now - 7 * DAY,
      lastUsedAt: now - 2 * MINUTE,
      tokensUsed: 41_200_117,
      creditsUsed: 702.11,
      requestsCount: 7_911,
    },
    {
      name: "Zed",
      createdAt: now - 5 * DAY,
      lastUsedAt: now - 11 * HOUR,
      tokensUsed: 120_442,
      creditsUsed: 2.04,
      requestsCount: 61,
    },
    { name: "Staging", createdAt: now - 2 * MINUTE },
    {
      name: "Load testing",
      createdAt: now - 30 * DAY,
      lastUsedAt: now - 29 * DAY,
      tokenLimit: 1_000_000,
      tokensUsed: 0,
      creditsUsed: 0,
      requestsCount: 0,
    },
    {
      name: "Partner: Brightline",
      createdAt: now - 90 * DAY,
      lastUsedAt: now - 50 * MINUTE,
      creditLimit: 0.5,
      creditsUsed: 0.4999,
      tokensUsed: 21_330,
      requestsCount: 12,
    },
    {
      name: "n8n workflows",
      createdAt: now - 45 * DAY,
      lastUsedAt: now - 15 * MINUTE,
      tokensUsed: 6_004_118,
      creditsUsed: 88.4,
      requestsCount: 4_022,
    },
    {
      name: "Open WebUI",
      createdAt: now - 21 * DAY,
      lastUsedAt: now - 6 * MINUTE,
      tokensUsed: 2_881_330,
      creditsUsed: 41.9,
      requestsCount: 1_903,
    },
    {
      name: "Legacy SDK",
      createdAt: now - 700 * DAY,
      lastUsedAt: now - 300 * DAY,
      tokensUsed: 4_118,
      creditsUsed: 0.07,
      requestsCount: 3,
    },
    {
      name: "Demo",
      key: "demo-key",
      createdAt: now - DAY,
      lastUsedAt: now - 22 * HOUR,
      requestsCount: 1,
      tokensUsed: 812,
      creditsUsed: 0.0101,
    },
    {
      name: "Continue.dev",
      createdAt: now - 10 * DAY,
      lastUsedAt: now - 70,
      tokenLimit: 10_000_000,
      creditLimit: 150,
      tokensUsed: 9_999_998,
      creditsUsed: 149.99,
      requestsCount: 5_510,
    },
    {
      name: "Aider",
      createdAt: now - 4 * DAY,
      lastUsedAt: now - 9 * MINUTE,
      tokensUsed: 702_118,
      creditsUsed: 12.4,
      requestsCount: 340,
    },
    { name: "Webhook relay", createdAt: now - 1 * DAY, tokenLimit: 250_000, creditLimit: 5 },
    {
      name: "Cline",
      enabled: false,
      createdAt: now - 8 * DAY,
      lastUsedAt: now - 3 * DAY,
      tokensUsed: 1_200_004,
      creditsUsed: 19.9,
      requestsCount: 701,
    },
  ];
  return rows.map((row, index) => {
    const key = row.key ?? sk();
    return {
      id: uuid(createRng(8100 + index)),
      keyMasked: maskKey(key),
      enabled: true,
      tokensUsed: 0,
      creditsUsed: 0,
      requestsCount: 0,
      ...row,
      key,
    };
  });
}

// ---------------------------------------------------------------------------
// Requests and errors
// ---------------------------------------------------------------------------

interface FailureTemplate {
  /** omitted = status 0 (no HTTP response), which Go leaves out */
  status?: number;
  message: string;
  /** false = failed before an account was chosen */
  routed: boolean;
}

/** Messages that classify to their type under proxy/request_trace.go classifyRequestError. */
const FAILURES: Record<RequestErrorType, readonly FailureTemplate[]> = {
  client_closed: [
    {
      status: 499,
      message: "client closed the connection before the response ended",
      routed: true,
    },
    { status: 499, message: "context canceled", routed: true },
  ],
  api_key_limit: [
    { status: 429, message: "token limit exceeded", routed: false },
    { status: 429, message: "credit limit exceeded", routed: false },
  ],
  overage: [
    { status: 402, message: "HTTP 402: overage cap reached for {email}", routed: true },
    {
      status: 402,
      message: "OverageLimitExceeded (402): monthly overage limit reached for this account",
      routed: true,
    },
  ],
  quota: [
    { status: 429, message: "monthly credits exhausted for {email}: quota exceeded", routed: true },
    {
      status: 403,
      message:
        "ServiceQuotaExceededException: You have reached the limit for this billing period (429)",
      routed: true,
    },
  ],
  suspended: [
    { status: 403, message: "TEMPORARILY_SUSPENDED: account {email} is suspended", routed: true },
    { status: 403, message: "account suspended: unusual user activity detected", routed: true },
  ],
  profile: [
    { status: 403, message: "no available Kiro profile for {email} in {region}", routed: true },
  ],
  auth: [
    { status: 401, message: "HTTP 401: access token expired for {email}", routed: true },
    {
      status: 403,
      message: "HTTP 403 forbidden: refresh token expired (invalid_grant)",
      routed: true,
    },
    { status: 401, message: "Invalid or missing API key", routed: false },
    { status: 401, message: "API key disabled", routed: false },
  ],
  stream: [
    { status: 502, message: "upstream stream ended before message_stop", routed: true },
    { status: 502, message: "upstream truncated response after 18432 bytes", routed: true },
    {
      status: 502,
      message: "upstream event stream: unexpected EOF while decoding frame headers",
      routed: true,
    },
  ],
  no_accounts: [
    { status: 503, message: "no available accounts", routed: false },
    {
      status: 503,
      message: "no available accounts: every account is disabled, banned or out of credits",
      routed: false,
    },
  ],
  invalid_request: [
    { status: 400, message: "messages: at least one message is required", routed: false },
    {
      status: 400,
      message:
        "max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-opus-5",
      routed: false,
    },
    { status: 405, message: "Method Not Allowed", routed: false },
    {
      status: 400,
      message:
        "messages.4.content.1.tool_result: tool_use_id toolu_01HZQ8 does not match any tool_use block in the previous message",
      routed: true,
    },
    {
      status: 400,
      message: "input is too long: 1,204,331 tokens > 1,000,000 maximum",
      routed: true,
    },
  ],
  rate_limit: [
    {
      status: 429,
      message: "ThrottlingException: Too many requests, wait and retry",
      routed: true,
    },
    { status: 429, message: "Rate exceeded", routed: true },
  ],
  timeout: [
    {
      status: 504,
      message: "upstream timeout after 300s waiting for the first byte",
      routed: true,
    },
    {
      status: 504,
      message: "context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
      routed: true,
    },
  ],
  upstream: [
    { status: 500, message: "InternalServerException: upstream returned 500", routed: true },
    {
      status: 503,
      message:
        "ServiceUnavailableException: The service is temporarily unavailable. Please try again.",
      routed: true,
    },
    { message: "dial tcp 52.94.233.129:443: connect: connection refused", routed: true },
  ],
  unknown: [
    {
      status: 409,
      message: "ConflictException: conversation is already in progress",
      routed: true,
    },
    { status: 422, message: "unexpected error while translating the response", routed: true },
  ],
};

const FAILURE_WEIGHTS: ReadonlyArray<readonly [RequestErrorType, number]> = [
  ["rate_limit", 22],
  ["upstream", 14],
  ["client_closed", 12],
  ["stream", 10],
  ["invalid_request", 9],
  ["timeout", 7],
  ["auth", 6],
  ["quota", 5],
  ["overage", 3],
  ["api_key_limit", 3],
  ["unknown", 3],
  ["suspended", 2],
  ["profile", 2],
  ["no_accounts", 2],
];

const RETRY_EVENTS = [
  {
    status: 429,
    message: "ThrottlingException: rate exceeded for {email}, retrying on another account",
  },
  { status: 502, message: "upstream connection reset by peer, retrying" },
  { status: 500, message: "InternalServerException: upstream returned 500, retrying" },
  { status: 403, message: "access token for {email} expired, refreshed and retried" },
  {
    status: 503,
    message: "ServiceUnavailableException in {region}, failing over to the next account",
  },
];

/** Requests per minute by age in minutes: dense now, thinning out over 30 days. */
function baseRate(ageMin: number): number {
  if (ageMin < 60) return 12;
  if (ageMin < 360) return 4.5;
  if (ageMin < 1440) return 2.2;
  if (ageMin < 7 * 1440) return 0.45;
  return 0.1;
}

/** Busy afternoons, quiet nights (local time), averaging 1. */
function diurnal(ts: number): number {
  const hour = new Date(ts * 1000).getHours();
  return 0.4 + 1.2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (hour - 3)) / 24));
}

type Episode = "throttle" | "outage" | "drained" | "keyScan" | "quiet" | null;

/** Incidents at fixed ages, so charts and the heatmap show spikes, gaps and failure bursts. */
function episodeAt(ageMin: number): Episode {
  if (ageMin >= 95 && ageMin < 107) return "throttle";
  if (ageMin >= 250 && ageMin < 262) return "quiet";
  if (ageMin >= 13 * 60 && ageMin < 13 * 60 + 6) return "keyScan";
  if (ageMin >= 2 * 1440 + 180 && ageMin < 2 * 1440 + 215) return "outage";
  if (ageMin >= 9 * 1440 + 600 && ageMin < 9 * 1440 + 640) return "drained";
  return null;
}

function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

interface RequestContext {
  rng: Rng;
  pickAccount: (rng: Rng) => Traffic | undefined;
  pickKey: (rng: Rng) => StoredKey | undefined;
  /** whether the key could have sent a request at ts */
  keyFits: (key: StoredKey, ts: number) => boolean;
  keyNeeded: number;
}

function fillTemplate(text: string, account: Account | undefined): string {
  return text
    .replace("{email}", account?.email || account?.id.slice(0, 12) || "unknown")
    .replace("{region}", account?.activeRegion || "us-east-1");
}

function successFields(rng: Rng, model: string) {
  const inTokens = logNormal(rng, 9, 1.4, 1, 1_000_000);
  const outTokens = logNormal(rng, 6.3, 1.3, 1, 128_000);
  const cacheReadTokens = rng() < 0.5 ? Math.floor(inTokens * (0.3 + rng() * 0.68)) : 0;
  const cacheWriteTokens = rng() < 0.15 ? Math.floor(inTokens * rng() * 0.3) : 0;
  const retried = rng() < 0.03;
  const durationMs = Math.min(
    290_000,
    250 +
      Math.round(outTokens * (6 + rng() * 19) + inTokens * 0.002) +
      (retried ? int(rng, 2000, 20_000) : 0),
  );
  return {
    inTokens,
    outTokens,
    cacheReadTokens,
    cacheWriteTokens,
    credits: credits(model, inTokens, outTokens, cacheReadTokens, cacheWriteTokens),
    durationMs,
  };
}

function failureDuration(rng: Rng, type: RequestErrorType): number {
  switch (type) {
    case "timeout":
      return rng() < 0.7 ? 300_000 : 120_000 + int(rng, 0, 999);
    case "client_closed":
      return int(rng, 500, 240_000);
    case "stream":
      return int(rng, 5_000, 180_000);
    case "rate_limit":
      return rng() < 0.6 ? int(rng, 20, 900) : int(rng, 2_000, 15_000);
    case "no_accounts":
    case "api_key_limit":
      return int(rng, 1, 5);
    case "auth":
    case "invalid_request":
      return int(rng, 1, 50);
    default:
      return int(rng, 100, 30_000);
  }
}

function makeRequest(
  ctx: RequestContext,
  ts: number,
  ageMin: number,
  episode: Episode,
  /** This failure, instead of drawing whether and how the request fails. */
  forced?: RequestErrorType,
): RequestRecord {
  const { rng } = ctx;
  const legacy = ageMin > 25 * 1440 && rng() < 0.3;
  const endpoint = legacy ? undefined : weighted(rng, ENDPOINT_WEIGHTS);
  const model = weighted(rng, MODEL_WEIGHTS);
  let key: StoredKey | undefined;
  if (rng() < ctx.keyNeeded) {
    for (let tries = 0; tries < 6 && !key; tries++) {
      const candidate = ctx.pickKey(rng);
      if (candidate && ctx.keyFits(candidate, ts)) key = candidate;
    }
    // A key deleted since: its id and mask outlive it in the log.
    if (key && rng() < 0.01) key = { ...key, id: uuid(rng), keyMasked: "sk-9f2c****e41a" };
  }
  const keyFields = key ? { apiKeyId: key.id, apiKeyMasked: key.keyMasked } : {};

  let traffic: Traffic | undefined;
  for (let tries = 0; tries < 10 && !traffic; tries++) {
    const candidate = ctx.pickAccount(rng);
    if (candidate && ts >= candidate.from && ts <= candidate.until) traffic = candidate;
  }
  const account = traffic?.account;

  let failure: RequestErrorType | null = null;
  if (forced) failure = forced;
  else if (episode === "keyScan") failure = "auth";
  else if (episode === "drained" || !account)
    failure = rng() < 0.9 || !account ? "no_accounts" : null;
  else if (episode === "throttle")
    failure = rng() < 0.22 ? (rng() < 0.85 ? "rate_limit" : "quota") : null;
  else if (episode === "outage") {
    failure =
      rng() < 0.75
        ? weighted(rng, [
            ["upstream", 5],
            ["stream", 3],
            ["timeout", 2],
          ] as const)
        : null;
  } else if (account.banTime && ts > account.banTime - 30 * MINUTE && rng() < 0.3) {
    failure = account.banStatus === "SUSPENDED" ? "suspended" : "auth";
  } else if (rng() < 0.012) {
    // About one request in a hundred fails outside the incidents: a healthy proxy's error rate.
    failure = weighted(rng, FAILURE_WEIGHTS);
  }

  if (!failure && account) {
    return makeRequestRecord({
      ts,
      endpoint,
      ...keyFields,
      accountId: account.id,
      email: account.email || undefined,
      model,
      ...successFields(rng, model),
      ...(legacy ? { durationMs: undefined } : {}),
    });
  }

  const type = failure ?? "no_accounts";
  const templates = FAILURES[type].filter((t) =>
    type === "auth" && episode === "keyScan" ? !t.routed && t.message.startsWith("Invalid") : true,
  );
  const template = pick(rng, templates);
  const routed = template.routed && Boolean(account);
  const partial = (type === "client_closed" || type === "stream") && routed && rng() < 0.6;
  const inTokens = partial ? logNormal(rng, 9, 1.2, 1, 400_000) : 0;
  const outTokens = partial ? logNormal(rng, 5, 1.2, 1, 20_000) : 0;
  // A missing key fails before the body is read; other early failures may know the model.
  const noKey = template.message === "Invalid or missing API key";
  const rowModel = routed
    ? model
    : type === "auth" || type === "api_key_limit" || (type === "invalid_request" && rng() < 0.5)
      ? ""
      : model;
  return makeRequestRecord({
    ts,
    endpoint,
    ...(noKey ? {} : keyFields),
    accountId: routed && account ? account.id : "",
    email: routed && account ? account.email || undefined : undefined,
    model: rowModel,
    inTokens,
    outTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: partial ? credits(model, inTokens, outTokens, 0, 0) : 0,
    success: false,
    status: template.status,
    errorType: type,
    message: fillTemplate(template.message, routed ? account : undefined),
    durationMs: legacy ? undefined : failureDuration(rng, type),
  });
}

/** Hand-made rows in the newest minutes: the extremes a random draw would rarely produce. */
function edgeRequests(now: number, accounts: Account[], keys: StoredKey[]): RequestRecord[] {
  // A day back, so the newest pages and the recent-errors table show everyday traffic.
  const edgeNow = now - DAY;
  const byEmail = (email: string) => accounts.find((a) => a.email === email) ?? accounts[0];
  const longEmail = accounts.reduce((a, b) => (b.email.length > a.email.length ? b : a));
  const noEmail = accounts.find((a) => a.email === "" && a.hasToken && a.enabled) ?? accounts[0];
  const prod = keys[4];
  const keyOf = (key: StoredKey) => ({ apiKeyId: key.id, apiKeyMasked: key.keyMasked });
  const of = (account: Account) => ({ accountId: account.id, email: account.email || undefined });
  const json500 =
    `upstream returned 502 Bad Gateway: {"__type":"com.amazon.coral.service#InternalFailure","message":"${"The upstream model endpoint returned an unexpected payload while assembling the streamed tool-use block; ".repeat(5)}`.slice(
      0,
      500,
    );
  const firehose = byEmail("platform@northwind.studio");
  return [
    makeRequestRecord({
      ts: edgeNow - 14,
      ...of(firehose),
      ...keyOf(prod),
      endpoint: "claude",
      model: "claude-opus-5-thinking",
      inTokens: 998_412,
      outTokens: 128_000,
      cacheReadTokens: 850_000,
      cacheWriteTokens: 120_000,
      credits: credits("claude-opus-5-thinking", 998_412, 128_000, 850_000, 120_000),
      durationMs: 284_512,
    }),
    makeRequestRecord({
      ts: edgeNow - 37,
      ...of(firehose),
      ...keyOf(prod),
      endpoint: "openai",
      model: "claude-haiku-4.5",
      inTokens: 1,
      outTokens: 1,
      credits: 0.0001,
      durationMs: 1,
    }),
    makeRequestRecord({
      ts: edgeNow - 95,
      ...of(firehose),
      ...keyOf(prod),
      endpoint: "responses",
      model: "claude-sonnet-5",
      inTokens: 0,
      outTokens: 0,
      credits: 0,
      success: false,
      status: 502,
      errorType: "upstream",
      message: json500,
      durationMs: 12_004,
    }),
    makeRequestRecord({
      ts: edgeNow - 140,
      ...of(byEmail("zoe.lindqvist@copperleaf.com")),
      endpoint: "claude",
      model: "claude-sonnet-4.6",
      inTokens: 0,
      outTokens: 0,
      credits: 0,
      success: false,
      status: 400,
      errorType: "invalid_request",
      message:
        'messages.0.content: invalid UTF-8 sequence near "résumé"\nhint: send the request body as UTF-8',
      durationMs: 3,
    }),
    makeRequestRecord({
      ts: edgeNow - 200,
      ...of(firehose),
      apiKeyId: "7d1e0f9a-8b7c-4a9e-b6c5-2d1e0f9a8b7c",
      apiKeyMasked: "sk-0ld3****dead",
      endpoint: "openai",
      model: "claude-sonnet-5",
      inTokens: 18_220,
      outTokens: 911,
      credits: credits("claude-sonnet-5", 18_220, 911, 0, 0),
      durationMs: 7_412,
    }),
    makeRequestRecord({
      ts: edgeNow - 260,
      accountId: "0b6f6a4e-3c1d-4e9a-8f00-deadbeef0001",
      email: "former.contractor@northwind.studio",
      endpoint: "claude",
      model: "claude-sonnet-4.5",
      inTokens: 5_002,
      outTokens: 640,
      credits: credits("claude-sonnet-4.5", 5_002, 640, 0, 0),
      durationMs: 4_118,
    }),
    makeRequestRecord({
      ts: edgeNow - 330,
      ...of(firehose),
      endpoint: "claude",
      model: "claude-sonnet-5",
      inTokens: 0,
      outTokens: 0,
      credits: 0,
      success: false,
      status: undefined,
      errorType: "upstream",
      message: "dial tcp 52.94.233.129:443: connect: connection refused",
      durationMs: 30_001,
    }),
    makeRequestRecord({
      ts: edgeNow - 410,
      ...of(firehose),
      ...keyOf(keys[11]),
      endpoint: "responses",
      model: LONG_MODEL,
      inTokens: 402_118,
      outTokens: 22_104,
      cacheReadTokens: 390_000,
      credits: credits(LONG_MODEL, 402_118, 22_104, 390_000, 0),
      durationMs: 141_220,
    }),
    makeRequestRecord({
      ts: edgeNow - 480,
      ...of(firehose),
      ...keyOf(keys[12]),
      endpoint: "responses",
      model: "claude-sonnet-5-thinking",
      inTokens: 61_004,
      outTokens: 3_310,
      cacheReadTokens: 0,
      credits: credits("claude-sonnet-5-thinking", 61_004, 3_310, 0, 0),
      success: false,
      status: 499,
      errorType: "client_closed",
      message: "client closed the connection before the response ended",
      durationMs: 48_112,
    }),
    makeRequestRecord({
      ts: edgeNow - 560,
      ...of(noEmail),
      endpoint: "openai",
      model: "auto",
      inTokens: 2_210,
      outTokens: 188,
      cacheReadTokens: 1_900,
      cacheWriteTokens: 310,
      credits: credits("auto", 2_210, 188, 1_900, 310),
      durationMs: 1_903,
    }),
    makeRequestRecord({
      ts: edgeNow - 640,
      ...of(longEmail),
      endpoint: "claude",
      model: "claude-opus-4.8",
      inTokens: 44_120,
      outTokens: 2_204,
      credits: credits("claude-opus-4.8", 44_120, 2_204, 0, 0),
      durationMs: 38_771,
    }),
  ];
}

function seedFullRequests(now: number, traffic: Traffic[], keys: StoredKey[]): RequestRecord[] {
  const rng = createRng(1101);
  const usable = keys.filter((k) => k.requestsCount > 0 || k.lastUsedAt);
  const ctx: RequestContext = {
    rng,
    pickAccount: weightedIndex(traffic, (t) => t.weight),
    // Capped like accounts, so the gateway key does not fill every page.
    pickKey: weightedIndex(usable, (k) => Math.min(250, Math.sqrt(k.requestsCount + 1))),
    keyFits: (key, ts) => key.createdAt <= ts && ts <= (key.lastUsedAt ?? 0) + 2 * MINUTE,
    keyNeeded: 0.93,
  };
  const records: RequestRecord[] = [];
  const currentMinute = Math.floor(now / 60) * 60;
  for (let age = 0; age < WINDOW_DAYS * 1440; age++) {
    const start = currentMinute - age * 60;
    const episode = episodeAt(age);
    if (episode === "quiet") continue;
    let lambda = baseRate(age) * (age >= 60 ? diurnal(start) : 1);
    if (episode === "throttle") lambda *= 3;
    if (episode === "keyScan") lambda += 20;
    const count = poisson(rng, lambda);
    const lastSecond = age === 0 ? now - start : 59;
    for (let i = 0; i < count; i++) {
      records.push(makeRequest(ctx, start + int(rng, 0, lastSecond), age, episode));
    }
  }
  // One failure of every type two to four days back, from its own PRNG: the random draw fails
  // about one request in a hundred, too few to promise each type at every hour of the day.
  const cover: RequestContext = { ...ctx, rng: createRng(1102) };
  FAILURE_WEIGHTS.forEach(([type], index) => {
    const age = 2 * 1440 + 600 + index * 97;
    records.push(makeRequest(cover, currentMinute - age * 60 + 17, age, null, type));
  });
  records.push(
    ...edgeRequests(
      now,
      traffic.map((t) => t.account),
      keys,
    ),
  );
  records.sort((a, b) => b.ts - a.ts);
  return records.map((record, index) => ({ ...record, id: records.length - index }));
}

/** The newest 100 error events: failed requests plus retried upstream errors (failover). */
function seedFullErrors(requests: RequestRecord[], accounts: Account[]): ObserveError[] {
  const rng = createRng(2102);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const serving = accounts.filter((a) => a.enabled && a.hasToken && a.lastUsed > 0);
  const events: ObserveError[] = [];
  for (const r of requests) {
    if (events.length >= 260) break;
    if (!r.success) {
      events.push(
        makeObserveError({
          ts: r.ts,
          accountId: r.accountId,
          email: r.email,
          model: r.model || undefined,
          status: r.status,
          message: r.message?.slice(0, 240),
        }),
      );
    } else if (rng() < 0.05 && serving.length > 0) {
      const other = pick(rng, serving);
      const retry = pick(rng, RETRY_EVENTS);
      events.push(
        makeObserveError({
          ts: r.ts - int(rng, 1, 4),
          accountId: other.id,
          email: other.email || undefined,
          model: r.model,
          status: retry.status,
          message: fillTemplate(retry.message, byId.get(other.id) ?? other),
        }),
      );
    }
  }
  return events.sort((a, b) => b.ts - a.ts).slice(0, 100);
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

function backupsFull(now: number): BackupEntry[] {
  const rng = createRng(3103);
  const entry = (createdAt: number, fields: Partial<BackupEntry>): BackupEntry => {
    const id = backupId(createdAt, rng);
    const accounts = fields.accountCnt ?? 0;
    const perAccount = fields.includesCredentials === false ? 1_150 : 3_250;
    return makeBackupEntry({
      id,
      createdAt,
      file: `${id}.json`,
      sha256: hex(rng, 64),
      size: 900 + accounts * perAccount + int(rng, 0, 4_000),
      version: "2.1.0",
      ...fields,
    });
  };
  const rows: BackupEntry[] = [];
  // Hourly schedule over the last day, daily before that.
  for (let h = 0; h < 12; h++) {
    rows.push(
      entry(now - 23 * MINUTE - h * HOUR, {
        kind: "scheduled",
        note: "auto-hourly",
        accountCnt: 120,
      }),
    );
  }
  for (let d = 1; d <= 10; d++) {
    rows.push(
      entry(now - d * DAY - int(rng, 0, 600), {
        kind: "scheduled",
        note: "auto-daily",
        accountCnt: 120 - d * 3,
        version: d > 5 ? "2.0.3" : "2.1.0",
      }),
    );
  }
  for (const w of [2, 3, 4, 6]) {
    rows.push(
      entry(now - w * 7 * DAY, {
        kind: "scheduled",
        note: "auto-weekly",
        accountCnt: 60 - w * 5,
        version: "2.0.3",
      }),
    );
  }
  const manual = [3 * MINUTE, 2 * HOUR + 7 * MINUTE, 26 * HOUR, 4 * DAY, 15 * DAY, 45 * DAY];
  for (const age of manual) {
    rows.push(entry(now - age, { kind: "manual", note: manualNote(now - age), accountCnt: 118 }));
  }
  const restored = rows[14];
  rows.push(
    entry(now - 30 * HOUR - 5 * MINUTE, {
      kind: "pre-restore",
      note: `auto before restore ${restored.id}`,
      accountCnt: 119,
      restoredAccountCnt: restored.accountCnt,
    }),
    entry(now - 3 * DAY - 2 * HOUR, {
      kind: "pre-restore",
      note: "upload kiro-backup-2026-09-01.json",
      accountCnt: 7,
      restoredAccountCnt: 6,
    }),
    entry(now - 20 * DAY, {
      kind: "pre-restore",
      note: "upload kiro-backup-weekly.json",
      // A file with no accounts: Go omits both zero counts.
      accountCnt: undefined,
    }),
  );
  rows.push(
    entry(now - 61 * DAY, {
      kind: "manual",
      note: "Before the v2 migration",
      accountCnt: 42,
      version: "1.9.12",
    }),
    entry(now - 90 * DAY, {
      kind: "manual",
      note: "Before the Q4 credential rotation",
      accountCnt: 37,
      version: "1.9.12",
    }),
    entry(now - 140 * DAY, {
      kind: "legacy-import",
      accountCnt: 12,
      version: undefined,
      format: undefined,
      includesCredentials: false,
    }),
    entry(now - 200 * DAY, {
      kind: "manual",
      accountCnt: undefined,
      version: "1.8.0",
      includesCredentials: false,
      size: 612,
    }),
    entry(now - 420 * DAY, {
      kind: "manual",
      note: "first backup",
      accountCnt: 9_400,
      includesCredentials: true,
      version: "1.7.2",
      size: 33_402_118,
    }),
  );
  return rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Many valid rules (lowercase unique sources, no chains) including a 256-byte source. */
/**
 * The defaults plus a handful of believable client aliases: about a screen of rules, so the
 * Settings card reads as a real install's (the small seed in fixtures.ts keeps the defaults).
 */
function modelMappingsFull(): ModelMappingRule[] {
  return [
    ...defaultModelMappings(),
    { key: "gpt-4o", value: "claude-sonnet-5" },
    { key: "gpt-4o-mini", value: "claude-haiku-4.5" },
    { key: "o3", value: "claude-opus-4.8-thinking" },
    { key: "gemini-2.5-pro", value: "claude-opus-5" },
    { key: "deepseek-chat", value: "claude-sonnet-4.5" },
    { key: "default", value: "auto" },
  ];
}

/** The built-in filters on and five custom rules of every type, one of them off. */
function promptFilterFull(): PromptFilterConfig {
  const base = 1_761_900_000_000;
  return {
    filterClaudeCode: true,
    filterEnvNoise: true,
    filterStripBoundaries: true,
    rules: [
      {
        id: `rule-${base}`,
        name: "Hide internal hostnames",
        type: "regex",
        match: "\\b[a-z0-9-]+\\.corp\\.northwind\\.studio\\b",
        replace: "internal-host",
        enabled: true,
      },
      {
        id: `rule-${base + 60_000}`,
        name: "Drop telemetry lines",
        type: "lines-containing",
        match: "telemetry-session-id",
        enabled: true,
      },
      {
        id: `rule-${base + 180_000}`,
        name: "Mask e-mail addresses",
        type: "regex",
        match: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
        replace: "user@example.com",
        enabled: true,
      },
      {
        id: `rule-${base + 240_000}`,
        name: "Drop debug lines",
        type: "lines-containing",
        match: "DEBUG",
        enabled: false,
      },
      {
        id: `rule-${base + 300_000}`,
        name: "Drop request ids",
        type: "contains",
        match: "x-amzn-requestid",
        enabled: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

/** Emails for the small seed's eight accounts in this dataset (an API-key label in sixth place). */
const BASE_EMAILS = [
  "dana.whitfield@northwind.studio",
  "maya.oyelaran@outlook.com",
  "priya.raman@gmail.com",
  "june.lee@proton.me",
  "ops@brightline.app",
  "review-bot-1",
  "elena.kovacs@northwind.onmicrosoft.com",
  "sam.okafor@gmail.com",
];

export function seedFullDataset(now: number): FullDataset {
  const rng = createRng(4104);
  const used = new Set<string>();
  const profiles = orgProfiles(rng);
  // The small seed's accounts lead the list; here they get the same polished names as the rest.
  const base = seedAccounts().map((account, index) => ({
    ...account,
    email: BASE_EMAILS[index] ?? account.email,
  }));
  const edges = edgeAccounts(now);
  for (const account of [...base, ...edges]) used.add(account.email);
  const random = Array.from({ length: ACCOUNT_COUNT - base.length - edges.length }, (_, i) =>
    randomAccount(rng, now, i, used, profiles),
  );
  const accounts = shuffle(rng, [...base, ...edges, ...random]);
  for (const account of accounts) {
    // A plan's usage percent is derived from the current/limit pair; keep the two in step.
    if (account.trialUsageLimit > 0) {
      account.trialUsagePercent = round(account.trialUsageCurrent / account.trialUsageLimit, 4);
    }
  }

  const apiKeys = apiKeysFull(now);
  const trafficRng = createRng(hashSeed("traffic"));
  const traffic = accounts.map((account) => trafficFor(account, now, trafficRng));
  const requests = seedFullRequests(now, traffic, apiKeys);

  // A serving account's last use is its newest request.
  const newest = new Map<string, number>();
  for (const r of requests)
    if (r.accountId && !newest.has(r.accountId)) newest.set(r.accountId, r.ts);
  for (const t of traffic) {
    const ts = newest.get(t.account.id);
    if (ts && t.until === Number.POSITIVE_INFINITY)
      t.account.lastUsed = Math.max(t.account.lastUsed, ts);
  }

  return {
    accounts,
    secrets: Object.fromEntries(accounts.map((account) => [account.id, makeAccountFull(account)])),
    apiKeys,
    requests,
    errors: seedFullErrors(requests, accounts),
    backups: backupsFull(now),
    schedule: { enabled: true, cadence: "hourly", keep: 50, lastRun: now - 23 * MINUTE },
    settings: {
      requireApiKey: true,
      port: 18080,
      host: "::",
      allowOverUsage: true,
      lenientStreamIntegrity: true,
      sessionAffinity: false,
      routingMode: "priority",
      accountRpmLimit: 60,
      autoContinue: true,
      autoContinueMax: 10,
      structuredToolHistory: false,
      usageRefreshIntervalMinutes: 60,
      imageResize: false,
      imageResizeMaxDimension: 2048,
      imageResizeMaxKB: 800,
    },
    thinking: {
      suffix: "-reasoning-extended",
      openaiFormat: "think",
      claudeFormat: "reasoning_content",
    },
    modelMappings: modelMappingsFull(),
    endpoint: { preferredEndpoint: "codewhisperer", endpointFallback: false },
    proxy: { proxyURL: "http://proxy.northwind.studio:3128" },
    promptFilter: promptFilterFull(),
    // Up for 9 days: the persisted log reaches further back than this process.
    startedAt: now - (9 * DAY + 4 * HOUR + 12 * MINUTE + 7),
  };
}

// ---------------------------------------------------------------------------
// Live traffic (the SSE tick in the full scenario)
// ---------------------------------------------------------------------------

/** One request for the live tick, drawn like the seeded ones, from what the database holds now. */
export function makeLiveRequest(
  accounts: Account[],
  keys: StoredKey[],
  now: number,
  id: number,
): RequestRecord {
  const rng = Math.random;
  const serving = accounts.filter(
    (a) => a.enabled && a.hasToken && (a.banStatus === "" || a.banStatus === "ACTIVE"),
  );
  const live = keys.filter((k) => k.enabled);
  const ctx: RequestContext = {
    rng,
    pickAccount: weightedIndex(
      serving.map((account) => ({
        account,
        weight: Math.min(2500, Math.sqrt(account.requestCount + 1)),
        from: 0,
        until: Number.POSITIVE_INFINITY,
      })),
      (t) => t.weight,
    ),
    pickKey: weightedIndex(live, (k) => Math.min(250, Math.sqrt(k.requestsCount + 1))),
    keyFits: () => true,
    keyNeeded: live.length > 0 ? 0.93 : 0,
  };
  return { ...makeRequest(ctx, now, 0, null), id };
}
