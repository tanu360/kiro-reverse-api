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

  it("keeps the Needs attention group as a status", () => {
    expect(validateAccountsSearch({ status: "attention" })).toEqual({ status: "attention" });
  });

  it("drops an invalid status", () => {
    expect(validateAccountsSearch({ status: "bogus" })).toEqual({});
    expect(validateAccountsSearch({ status: "all" })).toEqual({});
  });

  it("reads the old status=enabled link as the Enabled filter", () => {
    expect(validateAccountsSearch({ status: "enabled" })).toEqual({ enabled: "on" });
    expect(validateAccountsSearch({ status: "enabled", enabled: "off" })).toEqual({
      enabled: "off",
    });
  });

  it("keeps valid filters, sort and page, and drops invalid ones", () => {
    expect(
      validateAccountsSearch({
        status: "outOfCredits",
        plan: "pro",
        auth: "builderId",
        region: "eu-west-1",
        enabled: "off",
        sort: "usage",
        order: "desc",
        page: "3",
        pageSize: 50,
      }),
    ).toEqual({
      status: "outOfCredits",
      plan: "pro",
      auth: "builderId",
      region: "eu-west-1",
      enabled: "off",
      sort: "usage",
      order: "desc",
      page: 3,
      pageSize: 50,
    });
    expect(
      validateAccountsSearch({ enabled: "yes", sort: "tokens", order: "up", page: 0, pageSize: 7 }),
    ).toEqual({});
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
