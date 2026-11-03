import { describe, expect, it } from "vitest";
import type { AccountFull, ExportData, ModelInfo } from "@/lib/api/types";
import { makeAccount, makeAccountFull, makeModelInfo } from "@/lib/mocks/fixtures";
import {
  buildCopyJson,
  buildExportCopy,
  creditTone,
  filterAccounts,
  formatAuthMethod,
  formatCreditAmount,
  formatResetDate,
  healthBadges,
  isBanned,
  isValidMachineId,
  isValidProxyUrl,
  planLabel,
  sortModels,
  statusCounts,
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
    expect(formatAuthMethod("Enterprise", t)).toBe("Enterprise");
    expect(formatAuthMethod("", t)).toBe("—");
  });
});

describe("healthBadges", () => {
  const kinds = (overrides: Parameters<typeof makeAccount>[0]) =>
    healthBadges(makeAccount(overrides), NOW_SEC).map((badge) => badge.kind);

  it("shows Banned or Suspended for banned accounts and nothing for other ban values", () => {
    expect(kinds({ banStatus: "BANNED", enabled: false })).toEqual(["banned"]);
    expect(kinds({ banStatus: "SUSPENDED", enabled: false })).toEqual(["suspended"]);
    expect(kinds({ banStatus: "LOCKED", enabled: false })).toEqual([]);
  });

  it("shows No token, Expired or Active for healthy accounts", () => {
    expect(kinds({ hasToken: false })).toEqual(["noToken"]);
    expect(kinds({ expiresAt: NOW_SEC - 1 })).toEqual(["expired"]);
    expect(kinds({ expiresAt: 0 })).toEqual(["active"]);
    expect(kinds({ expiresAt: NOW_SEC + 60, banStatus: "ACTIVE" })).toEqual(["active"]);
  });

  it("adds Out of credits exactly like the server", () => {
    expect(kinds({ expiresAt: 0, usageLimit: 50, usageCurrent: 50 })).toEqual([
      "active",
      "outOfCredits",
    ]);
    expect(kinds({ expiresAt: 0, usageLimit: 50, usageCurrent: 49.9 })).toEqual(["active"]);
    expect(kinds({ expiresAt: 0, usageLimit: 0, usageCurrent: 10 })).toEqual(["active"]);
    expect(kinds({ banStatus: "BANNED", usageLimit: 50, usageCurrent: 60 })).toEqual([
      "banned",
      "outOfCredits",
    ]);
  });

  it("gives each badge a tone", () => {
    const badges = healthBadges(makeAccount({ hasToken: false }), NOW_SEC);
    expect(badges[0]).toEqual({ kind: "noToken", tone: "error" });
  });
});

describe("filterAccounts / statusCounts", () => {
  const accounts = [
    makeAccount({ id: "a", email: "Dana@Example.com", nickname: "Primary", enabled: true }),
    makeAccount({ id: "b", email: "bob@example.com", nickname: "", enabled: false }),
    makeAccount({ id: "c", email: "carol@example.com", enabled: false, banStatus: "BANNED" }),
    makeAccount({ id: "d", email: "dave@example.com", enabled: false, banStatus: "ACTIVE" }),
    makeAccount({ id: "e", email: "eve@example.com", enabled: false, banStatus: "SUSPENDED" }),
  ];
  const ids = (list: { id: string }[]) => list.map((a) => a.id);

  it("filters by status; banned is excluded from disabled", () => {
    expect(ids(filterAccounts(accounts, undefined, undefined))).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(filterAccounts(accounts, "enabled", undefined))).toEqual(["a"]);
    expect(ids(filterAccounts(accounts, "disabled", undefined))).toEqual(["b", "d"]);
    expect(ids(filterAccounts(accounts, "banned", undefined))).toEqual(["c", "e"]);
  });

  it("searches email or nickname, case-insensitively", () => {
    expect(ids(filterAccounts(accounts, undefined, "dana@"))).toEqual(["a"]);
    expect(ids(filterAccounts(accounts, undefined, "PRIM"))).toEqual(["a"]);
    expect(ids(filterAccounts(accounts, undefined, "  bob  "))).toEqual(["b"]);
    expect(ids(filterAccounts(accounts, "enabled", "bob"))).toEqual([]);
  });

  it("counts every filter", () => {
    expect(statusCounts(accounts)).toEqual({ all: 5, enabled: 1, disabled: 2, banned: 2 });
  });

  it("knows which accounts are banned", () => {
    expect(isBanned(accounts[2])).toBe(true);
    expect(isBanned(accounts[3])).toBe(false);
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
