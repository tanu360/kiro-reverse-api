import { describe, expect, it } from "vitest";
import type { ApiKey } from "@/lib/api/types";
import {
  type ApiKeyFormValues,
  buildCreateRequest,
  buildUpdateRequest,
  EMPTY_API_KEY_FORM,
  formValuesFromKey,
  isLimitReached,
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
      value: { name: "team-a", key: "", tokenLimit: 0, creditLimit: 0 },
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
    });
  });

  it("rejects a negative credit limit", () => {
    expect(parseApiKeyForm(values({ creditLimit: -1 }))).toEqual({
      ok: false,
      error: "invalidLimits",
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
    });
    expect(formValuesFromKey(key())).toEqual(EMPTY_API_KEY_FORM);
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
