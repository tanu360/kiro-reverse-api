import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import {
  cleanSearch,
  errorTypeTone,
  normalizeApiKeyMask,
  rowKey,
  toQueryParams,
} from "./request-model";

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    ts: 1_730_003_590,
    accountId: "acc-1",
    model: "claude-sonnet-5",
    inTokens: 10,
    outTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: 0.01,
    success: true,
    ...overrides,
  };
}

describe("errorTypeTone", () => {
  it.each(["client_closed", "invalid_request", "api_key_limit"])("%s is muted", (type) => {
    expect(errorTypeTone(type)).toBe("muted");
  });

  it.each(["stream", "timeout", "rate_limit", "upstream", "unknown"])("%s is a warning", (type) => {
    expect(errorTypeTone(type)).toBe("warning");
  });

  it.each([
    "overage",
    "quota",
    "suspended",
    "profile",
    "auth",
    "no_accounts",
    "something_new",
    "",
    undefined,
  ])("%s is destructive", (type) => {
    expect(errorTypeTone(type)).toBe("destructive");
  });
});

describe("normalizeApiKeyMask", () => {
  it("masks a long unmasked key as first6****last4", () => {
    expect(normalizeApiKeyMask("sk-abcdefghijklmn")).toBe("sk-abc****klmn");
  });

  it("keeps an already masked value", () => {
    expect(normalizeApiKeyMask("sk-abc****wxyz")).toBe("sk-abc****wxyz");
  });

  it("keeps a short key in full", () => {
    expect(normalizeApiKeyMask("short-key")).toBe("short-key");
    expect(normalizeApiKeyMask("0123456789")).toBe("0123456789");
  });

  it("returns an empty string for a missing key", () => {
    expect(normalizeApiKeyMask(undefined)).toBe("");
    expect(normalizeApiKeyMask("")).toBe("");
  });
});

describe("rowKey", () => {
  it("uses the id when present", () => {
    expect(rowKey(record({ id: 42 }), 3)).toBe("42");
  });

  it("falls back to ts and index without an id", () => {
    expect(rowKey(record({ id: undefined, ts: 1_730_000_000 }), 3)).toBe("1730000000-3");
  });
});

describe("toQueryParams", () => {
  it("applies the defaults", () => {
    expect(toQueryParams({})).toEqual({ page: 1, pageSize: 25, sort: "time", order: "desc" });
  });

  it("keeps set values and trims the search", () => {
    expect(
      toQueryParams({
        page: 3,
        pageSize: 50,
        search: "  sonnet ",
        status: "failed",
        sort: "tokens",
        order: "asc",
      }),
    ).toEqual({
      page: 3,
      pageSize: 50,
      search: "sonnet",
      status: "failed",
      sort: "tokens",
      order: "asc",
    });
  });

  it("drops an empty or blank search", () => {
    expect(toQueryParams({ search: "   " })).not.toHaveProperty("search");
    expect(toQueryParams({ search: "" })).not.toHaveProperty("search");
    expect(toQueryParams({})).not.toHaveProperty("status");
  });
});

describe("cleanSearch", () => {
  it("leaves default values out of the URL", () => {
    expect(
      cleanSearch({ page: 1, pageSize: 25, search: " ", sort: "time", order: "desc" }),
    ).toEqual({});
  });

  it("keeps non-default values", () => {
    expect(
      cleanSearch({
        page: 2,
        pageSize: 100,
        search: "x",
        status: "success",
        sort: "time",
        order: "asc",
      }),
    ).toEqual({
      page: 2,
      pageSize: 100,
      search: "x",
      status: "success",
      sort: "time",
      order: "asc",
    });
  });

  it("keeps the sort and its order together when either differs from the default", () => {
    expect(cleanSearch({ sort: "model", order: "desc" })).toEqual({ sort: "model", order: "desc" });
  });
});
