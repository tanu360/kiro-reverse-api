import { describe, expect, it } from "vitest";
import type { ApiKey } from "@/lib/api/types";
import {
  type ApiKeyFormValues,
  buildCreateRequest,
  buildUpdateRequest,
  EMPTY_API_KEY_FORM,
  formValuesFromKey,
  isLimitReached,
  limitReachedReason,
  parseApiKeyForm,
  wouldLockOutClients,
} from "./api-key-form";

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
