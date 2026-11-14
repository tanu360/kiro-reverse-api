import { describe, expect, it } from "vitest";
import type { ApiKey } from "@/lib/api/types";
import {
  type ApiKeyFormValues,
  buildCreateRequest,
  buildUpdateRequest,
  EMPTY_API_KEY_FORM,
  formValuesFromKey,
  fromLocalDateTimeInput,
  isKeyExpired,
  isLimitReached,
  limitReachedReason,
  parseApiKeyForm,
  parseModelList,
  toLocalDateTimeInput,
  wouldLockOutClients,
} from "./api-key-form";

/** What parse and the request builders give for the controls a plain form leaves alone. */
const NO_CONTROLS = {
  accountTags: [],
  allowedModels: [],
  rpmLimit: 0,
  expiresAt: 0,
  routingMode: "inherit",
} as const;

function values(overrides: Partial<ApiKeyFormValues> = {}): ApiKeyFormValues {
  return { ...EMPTY_API_KEY_FORM, ...overrides };
}

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k1",
    keyMasked: "sk-abc****1234",
    enabled: true,
    createdAt: 1_730_000_000,
    tokensUsed: 0,
    creditsUsed: 0,
    requestsCount: 0,
    ...overrides,
  };
}

describe("parseApiKeyForm", () => {
  it("treats empty limits as 0 (unlimited)", () => {
    const parsed = parseApiKeyForm(values({ name: "team-a" }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "team-a",
        key: "",
        tokenLimit: 0,
        creditLimit: 0,
        callLimit: 0,
        accountIds: [],
        ...NO_CONTROLS,
      },
    });
  });

  it("starts with limits of 0", () => {
    expect(EMPTY_API_KEY_FORM.tokenLimit).toBe(0);
    expect(EMPTY_API_KEY_FORM.creditLimit).toBe(0);
  });

  it("rejects a fractional token limit", () => {
    expect(parseApiKeyForm(values({ tokenLimit: 1.5 }))).toEqual({
      ok: false,
      error: "invalidLimits",
      field: "tokenLimit",
    });
  });

  it("rejects a negative credit limit", () => {
    expect(parseApiKeyForm(values({ creditLimit: -1 }))).toEqual({
      ok: false,
      error: "invalidLimits",
      field: "creditLimit",
    });
  });

  it("rejects a negative token limit and non-finite values", () => {
    expect(parseApiKeyForm(values({ tokenLimit: -1 })).ok).toBe(false);
    expect(parseApiKeyForm(values({ tokenLimit: Number.POSITIVE_INFINITY })).ok).toBe(false);
    expect(parseApiKeyForm(values({ creditLimit: Number.NaN })).ok).toBe(false);
  });

  it("accepts a fractional credit limit", () => {
    const parsed = parseApiKeyForm(values({ tokenLimit: 1000, creditLimit: 12.5 }));
    expect(parsed.ok && parsed.value).toMatchObject({ tokenLimit: 1000, creditLimit: 12.5 });
  });

  it("trims the name and the key", () => {
    const parsed = parseApiKeyForm(values({ name: "  team-a  ", key: "  sk-custom  " }));
    expect(parsed.ok && parsed.value).toMatchObject({ name: "team-a", key: "sk-custom" });
  });
});

describe("request payloads", () => {
  it("create omits a blank key and enables the key", () => {
    const parsed = parseApiKeyForm(values({ name: "ci", key: "   ", tokenLimit: 10 }));
    if (!parsed.ok) throw new Error("expected valid form");
    expect(buildCreateRequest(parsed.value)).toEqual({
      name: "ci",
      enabled: true,
      tokenLimit: 10,
      creditLimit: 0,
      callLimit: 0,
      accountIds: [],
      ...NO_CONTROLS,
    });
  });

  it("create sends a custom key", () => {
    const parsed = parseApiKeyForm(values({ name: "ci", key: "sk-mine" }));
    if (!parsed.ok) throw new Error("expected valid form");
    expect(buildCreateRequest(parsed.value)).toEqual({
      name: "ci",
      enabled: true,
      tokenLimit: 0,
      creditLimit: 0,
      callLimit: 0,
      accountIds: [],
      ...NO_CONTROLS,
      key: "sk-mine",
    });
  });

  it("edit always sends key, empty to keep the current one", () => {
    const parsed = parseApiKeyForm(values({ name: "ci", creditLimit: 2.5 }));
    if (!parsed.ok) throw new Error("expected valid form");
    expect(buildUpdateRequest(parsed.value)).toEqual({
      name: "ci",
      key: "",
      tokenLimit: 0,
      creditLimit: 2.5,
      callLimit: 0,
      accountIds: [],
      ...NO_CONTROLS,
    });
  });

  it("edit sends a replacement key", () => {
    const parsed = parseApiKeyForm(values({ key: " sk-new " }));
    if (!parsed.ok) throw new Error("expected valid form");
    expect(buildUpdateRequest(parsed.value).key).toBe("sk-new");
  });
});

describe("formValuesFromKey", () => {
  it("fills name and limits and leaves the key blank", () => {
    expect(formValuesFromKey(key({ name: "team-a", tokenLimit: 5, creditLimit: 1.25 }))).toEqual({
      name: "team-a",
      key: "",
      tokenLimit: 5,
      creditLimit: 1.25,
      callLimit: 0,
      accountScope: "all",
      accountIds: [],
      accountTags: [],
      allowedModels: "",
      rpmLimit: 0,
      expiresAt: "",
      routingMode: "inherit",
    });
    expect(formValuesFromKey(key())).toEqual(EMPTY_API_KEY_FORM);
    expect(formValuesFromKey(key({ accountIds: [] }))).toEqual(EMPTY_API_KEY_FORM);
  });

  it("starts a bound key on its accounts and its call limit", () => {
    expect(formValuesFromKey(key({ accountIds: ["a", "gone"], callLimit: 50 }))).toMatchObject({
      callLimit: 50,
      accountScope: "selected",
      accountIds: ["a", "gone"],
    });
  });
});

describe("call limit and accounts", () => {
  it("takes a whole call limit and rejects fractions and negatives", () => {
    const parsed = parseApiKeyForm(values({ callLimit: 25 }));
    expect(parsed.ok && parsed.value.callLimit).toBe(25);
    expect(parseApiKeyForm(values({ callLimit: null }))).toMatchObject({
      ok: true,
      value: { callLimit: 0 },
    });
    for (const callLimit of [1.5, -1, Number.NaN]) {
      expect(parseApiKeyForm(values({ callLimit }))).toEqual({
        ok: false,
        error: "invalidLimits",
        field: "callLimit",
      });
    }
  });

  it("needs an account when only selected accounts may be used", () => {
    expect(parseApiKeyForm(values({ accountScope: "selected", accountIds: [] }))).toEqual({
      ok: false,
      error: "noAccounts",
      field: "accountIds",
    });
  });

  it("sends the picks once each, and [] for every account", () => {
    const picked = parseApiKeyForm(
      values({ accountScope: "selected", accountIds: ["a", "b", "a"], callLimit: 3 }),
    );
    if (!picked.ok) throw new Error("expected valid form");
    expect(buildCreateRequest(picked.value)).toMatchObject({
      accountIds: ["a", "b"],
      callLimit: 3,
    });
    expect(buildUpdateRequest(picked.value)).toMatchObject({
      accountIds: ["a", "b"],
      callLimit: 3,
    });

    // Picks kept from before a switch to every account are not sent.
    const all = parseApiKeyForm(values({ accountScope: "all", accountIds: ["a"] }));
    if (!all.ok) throw new Error("expected valid form");
    expect(buildUpdateRequest(all.value).accountIds).toEqual([]);
  });
});

describe("isLimitReached", () => {
  it("is false for unlimited keys", () => {
    expect(isLimitReached(key({ tokensUsed: 10_000, creditsUsed: 99 }))).toBe(false);
  });

  it("detects a token or credit limit that was reached", () => {
    expect(isLimitReached(key({ tokenLimit: 100, tokensUsed: 100 }))).toBe(true);
    expect(isLimitReached(key({ creditLimit: 5, creditsUsed: 5.01 }))).toBe(true);
    expect(isLimitReached(key({ tokenLimit: 100, tokensUsed: 99, creditLimit: 5 }))).toBe(false);
  });

  it("tells a used-up call limit from a limit that disabled the key", () => {
    expect(limitReachedReason(key({ callLimit: 10, successfulCalls: 10 }))).toBe("calls");
    expect(limitReachedReason(key({ callLimit: 10, successfulCalls: 9 }))).toBeNull();
    expect(limitReachedReason(key({ callLimit: 0, successfulCalls: 99 }))).toBeNull();
    expect(
      limitReachedReason(key({ tokenLimit: 1, tokensUsed: 1, callLimit: 1, successfulCalls: 1 })),
    ).toBe("disabled");
    expect(isLimitReached(key({ callLimit: 1, successfulCalls: 1 }))).toBe(true);
  });
});

describe("wouldLockOutClients", () => {
  const keys = [key({ id: "a" }), key({ id: "b", enabled: false })];

  it("is true only for the last enabled key while keys are required", () => {
    expect(wouldLockOutClients(keys, "a", true)).toBe(true);
    expect(wouldLockOutClients(keys, "a", false)).toBe(false);
    expect(wouldLockOutClients(keys, "b", true)).toBe(false);
    expect(wouldLockOutClients([...keys, key({ id: "c" })], "a", true)).toBe(false);
  });
});

describe("key controls", () => {
  it("parses models comma-separated, once each, and checks their count and length", () => {
    expect(parseModelList(" claude-haiku-4.5, Claude-Haiku-4.5 ,auto,, ")).toEqual([
      "claude-haiku-4.5",
      "auto",
    ]);
    const many = Array.from({ length: 51 }, (_, i) => `model-${i}`).join(",");
    expect(parseApiKeyForm(values({ allowedModels: many }))).toEqual({
      ok: false,
      error: "tooManyModels",
      field: "allowedModels",
    });
    expect(parseApiKeyForm(values({ allowedModels: "m".repeat(129) }))).toEqual({
      ok: false,
      error: "modelTooLong",
      field: "allowedModels",
    });
  });

  it("takes a whole RPM limit up to 10,000", () => {
    expect(parseApiKeyForm(values({ rpmLimit: 30 }))).toMatchObject({
      ok: true,
      value: { rpmLimit: 30 },
    });
    for (const rpmLimit of [-1, 1.5, 10_001]) {
      expect(parseApiKeyForm(values({ rpmLimit }))).toEqual({
        ok: false,
        error: "invalidLimits",
        field: "rpmLimit",
      });
    }
  });

  it("round-trips the expiry through the local datetime field", () => {
    const at = Math.floor(new Date(2031, 4, 6, 7, 8).getTime() / 1000);
    expect(toLocalDateTimeInput(at)).toBe("2031-05-06T07:08");
    expect(fromLocalDateTimeInput("2031-05-06T07:08")).toBe(at);
    expect(toLocalDateTimeInput(0)).toBe("");
    expect(fromLocalDateTimeInput("  ")).toBe(0);
    expect(fromLocalDateTimeInput("tomorrow")).toBeNull();
    expect(parseApiKeyForm(values({ expiresAt: "2031-05-06" }))).toEqual({
      ok: false,
      error: "invalidExpiry",
      field: "expiresAt",
    });
  });

  it("lets tags alone satisfy only-selected accounts and sends every control", () => {
    const parsed = parseApiKeyForm(
      values({
        accountScope: "selected",
        accountTags: ["team-eu", "team-eu"],
        allowedModels: "claude-haiku-4.5",
        rpmLimit: 12,
        expiresAt: "2031-05-06T07:08",
        routingMode: "reset_first",
      }),
    );
    if (!parsed.ok) throw new Error("expected valid form");
    expect(buildUpdateRequest(parsed.value)).toMatchObject({
      accountIds: [],
      accountTags: ["team-eu"],
      allowedModels: ["claude-haiku-4.5"],
      rpmLimit: 12,
      expiresAt: fromLocalDateTimeInput("2031-05-06T07:08"),
      routingMode: "reset_first",
    });
    // Tags kept from before a switch to every account are not sent.
    const all = parseApiKeyForm(values({ accountScope: "all", accountTags: ["team-eu"] }));
    expect(all.ok && all.value.accountTags).toEqual([]);
  });

  it("starts an edit from the stored controls", () => {
    const at = Math.floor(new Date(2031, 0, 2, 3, 4).getTime() / 1000);
    expect(
      formValuesFromKey(
        key({
          accountTags: ["eu"],
          allowedModels: ["a", "b"],
          rpmLimit: 9,
          expiresAt: at,
          routingMode: "priority",
        }),
      ),
    ).toMatchObject({
      accountScope: "selected",
      accountTags: ["eu"],
      allowedModels: "a, b",
      rpmLimit: 9,
      expiresAt: "2031-01-02T03:04",
      routingMode: "priority",
    });
  });

  it("reads a key as expired from the flag or a stale time", () => {
    expect(isKeyExpired(key({ expired: true }))).toBe(true);
    expect(isKeyExpired(key({ expiresAt: 100 }), 200)).toBe(true);
    expect(isKeyExpired(key({ expiresAt: 300 }), 200)).toBe(false);
    expect(isKeyExpired(key())).toBe(false);
  });
});
