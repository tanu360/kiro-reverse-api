import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import {
  validateAccountsSearch,
  validateLoginSearch,
  validateOverviewSearch,
  validateRequestsSearch,
} from "./-search";

// TanStack Router merges a route's validated search over the raw URL search, so a validator
// that omits an invalid key lets the raw value through. These tests load the real route tree.

function leafSearch(router: Awaited<ReturnType<typeof renderApp>>["router"]) {
  return router.state.matches.at(-1)?.search as Record<string, unknown>;
}

describe("validators return every key they own", () => {
  it("sets invalid values to undefined instead of omitting them", () => {
    expect(validateOverviewSearch({ range: "7d" })).toStrictEqual({ range: undefined });
    expect(validateAccountsSearch({ status: "x" })).toStrictEqual({
      add: undefined,
      status: undefined,
      q: undefined,
    });
    expect(
      validateRequestsSearch({ page: -3, pageSize: 7, sort: "bogus", status: "x", order: "up" }),
    ).toStrictEqual({
      page: undefined,
      pageSize: undefined,
      search: undefined,
      status: undefined,
      sort: undefined,
      order: undefined,
    });
    expect(validateLoginSearch({ redirect: "//evil.com" })).toStrictEqual({ redirect: undefined });
  });
});

describe("invalid URL search values never reach a page", () => {
  it("drops an unknown Overview range and keeps the shell", { timeout: 20000 }, async () => {
    const { router } = await renderApp("/?range=7d");
    expect(leafSearch(router).range).toBeUndefined();
    expect(await screen.findByRole("navigation", { name: /main/i })).toBeInTheDocument();
    expect(screen.queryByText("Could not load this data")).not.toBeInTheDocument();
  });

  it("drops invalid Requests page, page size, sort and status", async () => {
    const { router } = await renderApp(
      "/requests?page=-3&pageSize=7&sort=bogus&status=x&order=desc",
    );
    const search = leafSearch(router);
    expect(search.page).toBeUndefined();
    expect(search.pageSize).toBeUndefined();
    expect(search.sort).toBeUndefined();
    expect(search.status).toBeUndefined();
    expect(search.order).toBe("desc");
  });

  it("drops an invalid Accounts status", async () => {
    const { router } = await renderApp("/accounts?status=bogus&q=abc");
    const search = leafSearch(router);
    expect(search.status).toBeUndefined();
    expect(search.q).toBe("abc");
  });

  it("drops an unsafe login redirect", async () => {
    const { router } = await renderApp("/login?redirect=//evil.com", { authed: false });
    expect(leafSearch(router).redirect).toBeUndefined();
  });
});
