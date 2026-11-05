import { describe, expect, it } from "vitest";
import type { AccountFull, ExportData, ModelInfo } from "@/lib/api/types";
import { makeAccount, makeAccountFull, makeModelInfo } from "@/lib/mocks/fixtures";
import {
  accountStatus,
  authKey,
  buildCopyJson,
  buildExportCopy,
  creditTone,
  describeFailures,
  filterAccounts,
  filterOptions,
  formatAuthMethod,
  formatCreditAmount,
  formatResetDate,
  isBanned,
  isHeld,
  isValidMachineId,
  isValidProxyUrl,
  planLabel,
  sortAccounts,
  sortModels,
  statusFilterGroup,
  statusGroup,
  subscriptionLabel,
  subscriptionTier,
  tokenExpiry,
  trialExpiry,
  usagePercent,
} from "./account-model";

// Returns the key, so tests check which message is chosen and not its wording.
const t = (key: string) => key;

const NOW_SEC = 1_800_000_000;
const DAY = 86_400;

describe("subscriptionTier / subscriptionLabel", () => {
  it("checks POWER before PRO_PLUS before PRO", () => {
    expect(subscriptionTier("Q_DEVELOPER_STANDALONE_POWER")).toBe("power");
    // A type naming both POWER and PRO is Power: POWER is checked first.
    expect(subscriptionTier("PRO_POWER")).toBe("power");
    expect(subscriptionTier("q_developer_standalone_pro_plus")).toBe("proPlus");
    expect(subscriptionTier("KIRO_PROPLUS")).toBe("proPlus");
    expect(subscriptionTier("Q_DEVELOPER_STANDALONE_PRO")).toBe("pro");
    expect(subscriptionTier("Q_DEVELOPER_STANDALONE_FREE")).toBe("free");
  });

  it("treats an empty type as Free and shows an unknown type as-is", () => {
    expect(subscriptionTier("")).toBe("free");
    expect(subscriptionLabel("", t)).toBe("subscription.free");
    expect(subscriptionTier("ENTERPRISE_SEAT")).toBeNull();
    expect(subscriptionLabel("ENTERPRISE_SEAT", t)).toBe("ENTERPRISE_SEAT");
    expect(subscriptionLabel("Q_DEVELOPER_STANDALONE_PRO_PLUS", t)).toBe("subscription.proPlus");
  });
});

describe("formatAuthMethod", () => {
  it("maps every known method, case-insensitively", () => {
    expect(formatAuthMethod("idc", t)).toBe("auth.enterprise");
    expect(formatAuthMethod("external_idp", t)).toBe("auth.microsoft");
    expect(formatAuthMethod("AzureAD", t)).toBe("auth.microsoft");
    expect(formatAuthMethod("apikey", t)).toBe("auth.apiKey");
    expect(formatAuthMethod("api_key", t)).toBe("auth.apiKey");
    expect(formatAuthMethod("social", t)).toBe("auth.social");
    expect(formatAuthMethod("BuilderID", t)).toBe("auth.builderId");
    expect(formatAuthMethod("Github", t)).toBe("auth.github");
    expect(formatAuthMethod("google", t)).toBe("auth.google");
  });

  it("returns an unknown method raw and an empty one as a dash", () => {
    expect(formatAuthMethod("SomethingNew", t)).toBe("SomethingNew");
    // The server's provider name for IAM Identity Center accounts is translated.
    expect(formatAuthMethod("Enterprise", t)).toBe("auth.enterprise");
    expect(formatAuthMethod("", t)).toBe("—");
  });
});

describe("accountStatus", () => {
  const status = (overrides: Parameters<typeof makeAccount>[0]) =>
    accountStatus(makeAccount({ expiresAt: 0, ...overrides }), NOW_SEC);

  it("shows Banned or Suspended first, and counts an unknown ban value as banned", () => {
    expect(status({ banStatus: "BANNED", enabled: false })).toBe("banned");
    expect(status({ banStatus: "SUSPENDED", enabled: false })).toBe("suspended");
    expect(status({ banStatus: "LOCKED" })).toBe("banned");
    expect(status({ banStatus: "BANNED", usageLimit: 50, usageCurrent: 60 })).toBe("banned");
  });

  it("then No token, Out of credits (the server's rule) and an expired token", () => {
    expect(status({ hasToken: false, usageLimit: 50, usageCurrent: 60 })).toBe("noToken");
    expect(status({ usageLimit: 50, usageCurrent: 50, expiresAt: NOW_SEC - 1 })).toBe(
      "outOfCredits",
    );
    expect(status({ usageLimit: 50, usageCurrent: 49.9 })).toBe("active");
    expect(status({ usageLimit: 0, usageCurrent: 10 })).toBe("active");
    expect(status({ expiresAt: NOW_SEC - 1, enabled: false })).toBe("expired");
  });

  it("shows Disabled only for an otherwise healthy account, else Active", () => {
    expect(status({ enabled: false })).toBe("disabled");
    expect(status({ expiresAt: NOW_SEC + 60, banStatus: "ACTIVE" })).toBe("active");
  });

  it("reads the server's DISABLED ban status as Disabled, not as a ban", () => {
    // config.SetAccountEnabled writes it when an account is switched off.
    expect(status({ banStatus: "DISABLED", enabled: false })).toBe("disabled");
    expect(status({ banStatus: "DISABLED", enabled: true })).toBe("disabled");
    // It keeps its place in the order: a missing token still wins.
    expect(status({ banStatus: "DISABLED", enabled: false, hasToken: false })).toBe("noToken");
  });
});

describe("filterAccounts / filterOptions", () => {
  const accounts = [
    makeAccount({
      id: "a",
      email: "Dana@Example.com",
      nickname: "Primary",
      enabled: true,
      expiresAt: 0,
      subscriptionType: "Q_DEVELOPER_STANDALONE_PRO",
      authMethod: "idc",
      provider: "",
      region: "eu-west-1",
    }),
    makeAccount({
      id: "b",
      email: "bob@example.com",
      nickname: "",
      enabled: false,
      expiresAt: 0,
      subscriptionType: "FREE",
      authMethod: "social",
      provider: "Enterprise",
      region: "",
    }),
    makeAccount({ id: "c", email: "carol@example.com", enabled: false, banStatus: "BANNED" }),
    makeAccount({ id: "d", email: "dave@example.com", enabled: false, banStatus: "SUSPENDED" }),
    makeAccount({
      id: "e",
      email: "erin@example.com",
      enabled: false,
      expiresAt: 0,
      banStatus: "DISABLED",
    }),
  ];
  const ids = (list: { id: string }[]) => list.map((a) => a.id);

  it("matches every set filter against the value the row shows", () => {
    expect(ids(filterAccounts(accounts, {}, NOW_SEC))).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(filterAccounts(accounts, { enabled: "on" }, NOW_SEC))).toEqual(["a"]);
    expect(ids(filterAccounts(accounts, { status: "disabled" }, NOW_SEC))).toEqual(["b", "e"]);
    expect(ids(filterAccounts(accounts, { status: "banned" }, NOW_SEC))).toEqual(["c"]);
    // Needs attention takes every problem status: banned and suspended here.
    expect(ids(filterAccounts(accounts, { status: "attention" }, NOW_SEC))).toEqual(["c", "d"]);
    expect(ids(filterAccounts(accounts, { plan: "pro" }, NOW_SEC))).toEqual(["a"]);
    // The provider wins over the auth method, and both names of a method share one id.
    expect(ids(filterAccounts(accounts, { auth: "enterprise" }, NOW_SEC))).toEqual(["a", "b"]);
    expect(ids(filterAccounts(accounts, { region: "us-east-1", enabled: "off" }, NOW_SEC))).toEqual(
      ["b", "c", "d", "e"],
    );
  });

  it("searches email or nickname, case-insensitively", () => {
    expect(ids(filterAccounts(accounts, { q: "dana@" }, NOW_SEC))).toEqual(["a"]);
    expect(ids(filterAccounts(accounts, { q: "PRIM" }, NOW_SEC))).toEqual(["a"]);
    expect(ids(filterAccounts(accounts, { q: "  bob  " }, NOW_SEC))).toEqual(["b"]);
    expect(ids(filterAccounts(accounts, { q: "bob", enabled: "on" }, NOW_SEC))).toEqual([]);
  });

  it("lists each value once with its count, statuses worst first", () => {
    expect(filterOptions(accounts, "status", t, NOW_SEC)).toEqual([
      { value: "banned", label: "health.banned", count: 1 },
      { value: "suspended", label: "health.suspended", count: 1 },
      { value: "disabled", label: "health.disabled", count: 2 },
      { value: "active", label: "health.active", count: 1 },
    ]);
    expect(filterOptions(accounts, "enabled", t, NOW_SEC).map((o) => [o.value, o.count])).toEqual([
      ["on", 1],
      ["off", 4],
    ]);
  });

  it("gives every name of an auth method one id", () => {
    expect(authKey({ provider: "", authMethod: "idc" })).toBe("enterprise");
    expect(authKey({ provider: "BuilderId", authMethod: "social" })).toBe("builderId");
    expect(authKey({ provider: "Okta", authMethod: "external_idp" })).toBe("okta");
  });

  it("knows which accounts are banned, and that DISABLED is not a ban", () => {
    expect(isBanned(accounts[2])).toBe(true);
    expect(isBanned(accounts[3])).toBe(true);
    expect(isBanned(accounts[0])).toBe(false);
    expect(isBanned(accounts[4])).toBe(false);
    expect(isHeld(accounts[4])).toBe(true);
  });
});

describe("sortAccounts", () => {
  const accounts = [
    makeAccount({ id: "a", email: "b@x.com", requestCount: 5, lastUsed: 0, expiresAt: 0 }),
    makeAccount({ id: "b", email: "a@x.com", requestCount: 9, lastUsed: 100, usageLimit: 0 }),
    makeAccount({ id: "c", email: "c@x.com", requestCount: 5, lastUsed: 300, banStatus: "BANNED" }),
  ];
  const ids = (list: { id: string }[]) => list.map((a) => a.id);

  it("keeps the server order without a sort", () => {
    expect(sortAccounts(accounts, undefined, false, NOW_SEC)).toBe(accounts);
  });

  it("sorts both ways and keeps ties in server order", () => {
    expect(ids(sortAccounts(accounts, "account", false, NOW_SEC))).toEqual(["b", "a", "c"]);
    expect(ids(sortAccounts(accounts, "requests", true, NOW_SEC))).toEqual(["b", "a", "c"]);
    expect(ids(sortAccounts(accounts, "requests", false, NOW_SEC))).toEqual(["a", "c", "b"]);
    expect(ids(sortAccounts(accounts, "status", false, NOW_SEC))[0]).toBe("c");
  });

  it("keeps missing values last in both directions", () => {
    expect(ids(sortAccounts(accounts, "lastUsed", true, NOW_SEC))).toEqual(["c", "b", "a"]);
    expect(ids(sortAccounts(accounts, "lastUsed", false, NOW_SEC))).toEqual(["b", "c", "a"]);
  });
});

describe("trialExpiry", () => {
  const nowMs = NOW_SEC * 1000;
  it("labels expired, today, days left and far-off expiries", () => {
    expect(trialExpiry(0, nowMs)).toBeNull();
    expect(trialExpiry(NOW_SEC - DAY, nowMs)).toEqual({ kind: "expired" });
    expect(trialExpiry(NOW_SEC, nowMs)).toEqual({ kind: "today" });
    expect(trialExpiry(NOW_SEC + 3 * DAY, nowMs)).toEqual({ kind: "days", days: 3 });
    expect(trialExpiry(NOW_SEC + 7 * DAY, nowMs)).toEqual({ kind: "days", days: 7 });
    expect(trialExpiry(NOW_SEC + 10 * DAY, nowMs)).toBeNull();
  });
});

describe("tokenExpiry", () => {
  it("handles the boundaries", () => {
    expect(tokenExpiry(0, NOW_SEC)).toEqual({ kind: "none" });
    expect(tokenExpiry(NOW_SEC, NOW_SEC)).toEqual({ kind: "expired" });
    expect(tokenExpiry(NOW_SEC - 5, NOW_SEC)).toEqual({ kind: "expired" });
    expect(tokenExpiry(NOW_SEC + 59, NOW_SEC)).toEqual({ kind: "minutes", value: 0 });
    expect(tokenExpiry(NOW_SEC + 3599, NOW_SEC)).toEqual({ kind: "minutes", value: 59 });
    expect(tokenExpiry(NOW_SEC + 3600, NOW_SEC)).toEqual({ kind: "hours", value: 1 });
    expect(tokenExpiry(NOW_SEC + DAY - 1, NOW_SEC)).toEqual({ kind: "hours", value: 23 });
    expect(tokenExpiry(NOW_SEC + DAY, NOW_SEC)).toEqual({ kind: "days", value: 1 });
  });
});

describe("usagePercent / creditTone", () => {
  it("clamps the fraction to 0..100", () => {
    expect(usagePercent(0.4567)).toBeCloseTo(45.67);
    expect(usagePercent(1.4)).toBe(100);
    expect(usagePercent(-1)).toBe(0);
  });

  it("warns over 70 and is destructive over 90", () => {
    expect(creditTone(70)).toBe("default");
    expect(creditTone(70.1)).toBe("warning");
    expect(creditTone(90)).toBe("warning");
    expect(creditTone(90.1)).toBe("destructive");
  });
});

describe("isValidMachineId / isValidProxyUrl", () => {
  it("accepts empty, a UUID in any case and 32 hex characters", () => {
    expect(isValidMachineId("")).toBe(true);
    expect(isValidMachineId("8F14E45F-CEEA-467F-A0E6-B5C2D9A1F3E7")).toBe(true);
    expect(isValidMachineId("8f14e45fceea467fa0e6b5c2d9a1f3e7")).toBe(true);
    expect(isValidMachineId("8f14e45f-ceea-467f-a0e6")).toBe(false);
    expect(isValidMachineId("zz14e45fceea467fa0e6b5c2d9a1f3e7")).toBe(false);
    expect(isValidMachineId("8f14e45fceea467fa0e6b5c2d9a1f3e7a")).toBe(false);
  });

  it("accepts empty and the four proxy schemes only", () => {
    expect(isValidProxyUrl("")).toBe(true);
    expect(isValidProxyUrl("socks5://127.0.0.1:1080")).toBe(true);
    expect(isValidProxyUrl("socks5h://host:1080")).toBe(true);
    expect(isValidProxyUrl("http://proxy:3128")).toBe(true);
    expect(isValidProxyUrl("https://proxy:443")).toBe(true);
    expect(isValidProxyUrl("ftp://proxy")).toBe(false);
    expect(isValidProxyUrl("127.0.0.1:1080")).toBe(false);
  });
});

describe("buildCopyJson", () => {
  const full = (overrides: Partial<AccountFull>): AccountFull => ({
    ...makeAccountFull(makeAccount()),
    clientId: "cid",
    clientSecret: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    ...overrides,
  });

  it("returns the API key, region and method for api_key accounts", () => {
    expect(
      buildCopyJson(full({ authMethod: "api_key", kiroApiKey: "ksk_abc", region: "eu-central-1" })),
    ).toEqual({ kiroApiKey: "ksk_abc", region: "eu-central-1", authMethod: "api_key" });
    expect(buildCopyJson(full({ authMethod: "api_key", kiroApiKey: "" })).kiroApiKey).toBe(
      "access",
    );
  });

  it("returns the OIDC fields for external_idp accounts", () => {
    const value = buildCopyJson(
      full({
        authMethod: "external_idp",
        provider: "AzureAD",
        userId: "user-1",
        profileArn: "arn:x",
        tokenEndpoint: "https://login/token",
        issuerUrl: "https://login",
        scopes: "openid",
      }),
    );
    expect(value).toEqual({
      clientId: "cid",
      accessToken: "access",
      refreshToken: "refresh",
      authMethod: "external_idp",
      provider: "AzureAD",
      userId: "user-1",
      profileArn: "arn:x",
      tokenEndpoint: "https://login/token",
      issuerUrl: "https://login",
      scopes: "openid",
    });
    expect(Object.keys(value)).not.toContain("clientSecret");
  });

  it("returns client and token fields for every other account", () => {
    expect(buildCopyJson(full({ authMethod: "idc" }))).toEqual({
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "access",
      refreshToken: "refresh",
    });
  });
});

describe("buildExportCopy", () => {
  it("keeps only the credentials a client needs", () => {
    const credentials = {
      csrfToken: "",
      expiresAt: 0,
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "access",
      refreshToken: "refresh",
    };
    const data = {
      version: "2.1.0",
      exportedAt: 0,
      groups: [],
      tags: [],
      accounts: [
        {
          credentials: { ...credentials, authMethod: "api_key", accessToken: "ksk_1", region: "r" },
        },
        { credentials: { ...credentials, authMethod: "IdC", region: "us-east-1" } },
      ],
    } as unknown as ExportData;
    expect(buildExportCopy(data)).toEqual([
      { kiroApiKey: "ksk_1", region: "r", authMethod: "api_key" },
      { clientId: "cid", clientSecret: "secret", accessToken: "access", refreshToken: "refresh" },
    ]);
  });
});

describe("sortModels", () => {
  it("puts auto first, then sorts by credit multiplier", () => {
    const models: ModelInfo[] = [
      makeModelInfo({ modelId: "claude-opus-5", rateMultiplier: 2.2 }),
      makeModelInfo({ modelId: "claude-haiku-4.5", rateMultiplier: 0.4 }),
      makeModelInfo({ modelId: "claude-sonnet-4.6", rateMultiplier: 0 }),
      makeModelInfo({ modelId: "auto", rateMultiplier: 1 }),
    ];
    expect(sortModels(models).map((m) => m.modelId)).toEqual([
      "auto",
      "claude-haiku-4.5",
      "claude-sonnet-4.6",
      "claude-opus-5",
    ]);
  });
});

describe("formatCreditAmount", () => {
  it("groups thousands and keeps at most one decimal", () => {
    expect(formatCreditAmount(1488.92, "en")).toBe("1,488.9");
    expect(formatCreditAmount(9200, "en")).toBe("9,200");
    expect(formatCreditAmount(312.48, "en")).toBe("312.5");
    expect(formatCreditAmount(0, "en")).toBe("0");
  });

  it("shows a tiny non-zero amount as <0.1, not as 0", () => {
    expect(formatCreditAmount(0.0001, "en")).toBe("<0.1");
    expect(formatCreditAmount(0.04, "pt-BR")).toBe("<0,1");
    expect(formatCreditAmount(0.05, "en")).toBe("0.1");
  });

  it("treats a non-number as zero", () => {
    expect(formatCreditAmount(Number.NaN, "en")).toBe("0");
  });
});

describe("formatResetDate", () => {
  it("formats a calendar day as a medium date, in UTC", () => {
    expect(formatResetDate("2026-12-01", "en")).toBe("Dec 1, 2026");
  });

  it("shows a dash for an empty date and keeps unparsable text", () => {
    expect(formatResetDate("", "en")).toBe("—");
    expect(formatResetDate("soon", "en")).toBe("soon");
  });
});

describe("planLabel", () => {
  it("uses the list badge label for a known plan, not the raw server title", () => {
    const account = {
      subscriptionType: "Q_DEVELOPER_STANDALONE_PRO",
      subscriptionTitle: "KIRO PRO",
    };
    expect(planLabel(account, t)).toBe("subscription.pro");
  });

  it("falls back to the server title for an unknown plan", () => {
    const account = { subscriptionType: "ENTERPRISE_X", subscriptionTitle: "Kiro Team" };
    expect(planLabel(account, t)).toBe("Kiro Team");
  });
});

describe("statusGroup / statusFilterGroup", () => {
  it("puts every problem status under attention and keeps active and disabled apart", () => {
    expect(statusGroup("active")).toBe("active");
    expect(statusGroup("disabled")).toBe("disabled");
    for (const status of ["banned", "suspended", "noToken", "outOfCredits", "expired"] as const) {
      expect(statusGroup(status)).toBe("attention");
    }
  });

  it("maps a status filter to its tab, so an old single-status link opens Needs attention", () => {
    expect(statusFilterGroup(undefined)).toBeUndefined();
    expect(statusFilterGroup("attention")).toBe("attention");
    expect(statusFilterGroup("expired")).toBe("attention");
    expect(statusFilterGroup("active")).toBe("active");
  });
});

describe("describeFailures", () => {
  const tp = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key;
  const nameOf = (id: string) => `name-${id}`;

  it("is empty when nothing failed", () => {
    expect(describeFailures([{ id: "a", ok: true }], nameOf, tp)).toBe("");
    expect(describeFailures(undefined, nameOf, tp)).toBe("");
  });

  it("names the first failures with their reason, then counts the rest", () => {
    const results = [
      { id: "a", ok: false, error: "token expired" },
      { id: "b", ok: true },
      { id: "c", ok: false, status: "not_found" as const },
      { id: "d", ok: false },
      { id: "e", ok: false, error: "x" },
      { id: "f", ok: false, error: "y" },
    ];
    expect(describeFailures(results, nameOf, tp).split("\n")).toEqual([
      "name-a: token expired",
      "name-c: batch.notFound",
      "name-d",
      'batch.moreFailures:{"count":2}',
    ]);
  });
});
