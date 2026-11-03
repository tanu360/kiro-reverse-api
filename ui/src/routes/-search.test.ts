import { describe, expect, it } from "vitest";
import {
  redirectTarget,
  validateAccountsSearch,
  validateLoginSearch,
  validateOverviewSearch,
  validateRequestsSearch,
} from "./-search";

describe("validateAccountsSearch", () => {
  it("normalizes add and keeps a valid status and query", () => {
    expect(validateAccountsSearch({ add: "1", status: "banned", q: "x" })).toEqual({
      add: true,
      status: "banned",
      q: "x",
    });
    expect(validateAccountsSearch({ add: 1 })).toEqual({ add: true });
    expect(validateAccountsSearch({ add: true })).toEqual({ add: true });
  });

  it("drops an invalid status", () => {
    expect(validateAccountsSearch({ status: "bogus" })).toEqual({});
    expect(validateAccountsSearch({ status: "all" })).toEqual({});
  });
});

describe("validateRequestsSearch", () => {
  it("drops an invalid page, page size and sort", () => {
    expect(validateRequestsSearch({ page: "0", pageSize: "77", sort: "bogus" })).toEqual({});
  });

  it("keeps valid values and coerces numbers", () => {
    expect(
      validateRequestsSearch({
        page: "3",
        pageSize: 50,
        search: "claude",
        status: "failed",
        sort: "tokens",
        order: "asc",
      }),
    ).toEqual({
      page: 3,
      pageSize: 50,
      search: "claude",
      status: "failed",
      sort: "tokens",
      order: "asc",
    });
    expect(validateRequestsSearch({ page: 1.5, status: "ok", order: "up" })).toEqual({});
  });
});

describe("validateOverviewSearch", () => {
  it("keeps only known ranges", () => {
    expect(validateOverviewSearch({ range: "6h" })).toEqual({ range: "6h" });
    expect(validateOverviewSearch({ range: "7d" })).toEqual({});
  });
});

describe("validateLoginSearch", () => {
  it("rejects protocol-relative and backslash redirects", () => {
    expect(validateLoginSearch({ redirect: "//evil.com" })).toEqual({});
    expect(validateLoginSearch({ redirect: "/\\evil.com" })).toEqual({});
    expect(validateLoginSearch({ redirect: "https://evil.com" })).toEqual({});
  });

  it("keeps an app path", () => {
    expect(validateLoginSearch({ redirect: "/accounts" })).toEqual({ redirect: "/accounts" });
  });
});

describe("redirectTarget", () => {
  it("splits the path from its query string", () => {
    expect(redirectTarget("/requests?page=2&status=failed")).toEqual({
      to: "/requests",
      search: { page: "2", status: "failed" },
    });
  });

  it("falls back to Overview", () => {
    expect(redirectTarget(undefined)).toEqual({ to: "/", search: {} });
    expect(redirectTarget("//evil.com")).toEqual({ to: "/", search: {} });
  });
});
