import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import {
  cleanSearch,
  errorTypeForSearch,
  errorTypeTone,
  formatRowDate,
  isSecretSearch,
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

  it.each(["proxy", "stream", "timeout", "rate_limit", "upstream", "unknown"])(
    "%s is a warning",
    (type) => {
      expect(errorTypeTone(type)).toBe("warning");
    },
  );

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

describe("formatRowDate", () => {
  // 2026-11-03 12:00 local time, and the same day a year earlier.
  const thisYear = new Date(2026, 10, 3, 12).getTime() / 1000;
  const lastYear = new Date(2025, 10, 3, 12).getTime() / 1000;
  const now = new Date(2026, 10, 4, 9);

  it("drops the year for rows from the current year", () => {
    expect(formatRowDate(thisYear, "en", now)).toBe("Nov 3");
    expect(formatRowDate(thisYear, "zh", now)).toBe("11月3日");
  });

  it("keeps the year for older rows", () => {
    expect(formatRowDate(lastYear, "en", now)).toBe("Nov 3, 2025");
    expect(formatRowDate(lastYear, "zh", now)).toBe("2025年11月3日");
  });
});

describe("isSecretSearch", () => {
  it("treats key-like text as a secret and everything else as plain search", () => {
    for (const secret of [
      "sk-bogus1",
      "sk-clb-0123456789abcdef",
      "KSK_abcdef",
      "abcdefghijklmnopqrstuvwxyz",
    ]) {
      expect(isSecretSearch(secret)).toBe(true);
    }
    for (const plain of ["sonnet", "proxy", "sk-clb****e4yo", "claude haiku 4.5", "", "  "]) {
      expect(isSecretSearch(plain)).toBe(false);
    }
  });
});

describe("errorTypeForSearch", () => {
  it("reads an error type label in the page language or English, and leaves the rest alone", () => {
    expect(errorTypeForSearch("Proxy error", "en")).toBe("proxy");
    expect(errorTypeForSearch("  proxy ERROR ", "en")).toBe("proxy");
    expect(errorTypeForSearch("代理错误", "zh")).toBe("proxy");
    expect(errorTypeForSearch("Proxy error", "zh")).toBe("proxy");
    expect(errorTypeForSearch("API key limit", "pt-BR")).toBe("api_key_limit");
    expect(errorTypeForSearch("proxy", "en")).toBeUndefined();
    expect(errorTypeForSearch("sonnet", "en")).toBeUndefined();
  });

  it("sends the type, not the text, when the search names one", () => {
    expect(toQueryParams({ search: "Proxy error" }, "en")).toMatchObject({ errorType: "proxy" });
    expect(toQueryParams({ search: "Proxy error" }, "en")).not.toHaveProperty("search");
    expect(toQueryParams({ search: "Proxy error" })).toMatchObject({ search: "Proxy error" });
  });
});
