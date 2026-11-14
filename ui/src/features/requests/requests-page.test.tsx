import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTime, unixToDate } from "@/lib/format";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { maskEmail, maskEmailsInText } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { renderApp } from "@/test/render";
import { inMemoryRequestsHandler } from "./mocks";
import { formatRowDate } from "./request-model";

const RECENT_REQUESTS = apiUrl("/observe/recent-requests");

/**
 * Records every list request, then falls through to the feature mock. The tab counts' one-row
 * pages (requestCountsQuery) are left out: the list never asks for a page of one.
 */
function recordRequests(): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  mockServer.use(
    http.get(RECENT_REQUESTS, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("pageSize") !== "1") seen.push(params);
    }),
  );
  return seen;
}

function statusTabs(): HTMLElement {
  return screen.getByRole("tablist", { name: "Status" });
}

function last(seen: URLSearchParams[]): URLSearchParams {
  const params = seen.at(-1);
  if (!params) throw new Error("no request recorded");
  return params;
}

function bodyRows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

async function waitForRows(count = 25): Promise<void> {
  await waitFor(() => expect(bodyRows()).toHaveLength(count));
}

// jsdom has no window.scrollTo; the router calls it on every navigation. restoreMocks undoes
// the spy after each test, so it is set per test.
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RequestsPage", () => {
  it("renders the first 25 rows and the page info", async () => {
    const seen = recordRequests();
    await renderApp("/requests");
    await waitForRows();
    expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument();
    expect(screen.getByText("1–25 of 320")).toBeInTheDocument();
    const params = last(seen);
    expect(params.get("page")).toBe("1");
    expect(params.get("pageSize")).toBe("25");
    expect(params.get("sort")).toBe("time");
    expect(params.get("order")).toBe("desc");
    expect(params.has("search")).toBe(false);
    expect(params.has("status")).toBe(false);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("debounces the search by 250 ms, resets the page and keeps the search out of the URL", async () => {
    const seen = recordRequests();
    const { router } = await renderApp("/requests?page=2");
    await waitForRows();
    expect(last(seen).get("page")).toBe("2");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search requests" }), {
      target: { value: "  sonnet " },
    });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(last(seen).has("search")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();

    await waitFor(() => expect(last(seen).get("search")).toBe("sonnet"));
    expect(last(seen).get("page")).toBe("1");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.href).toBe("/requests");
    expect(seen.every((params) => params.get("search") !== "  sonnet ")).toBe(true);
  });

  it("keeps a key-like search out of the URL but still sends it to the server", async () => {
    const seen = recordRequests();
    const { router } = await renderApp("/requests");
    await waitForRows();

    const key = "sk-live-0123456789abcdefghijklmn";
    fireEvent.change(screen.getByRole("searchbox", { name: "Search requests" }), {
      target: { value: key },
    });
    await waitFor(() => expect(last(seen).get("search")).toBe(key));
    expect(router.state.location.search).not.toHaveProperty("search");
    expect(router.state.location.href).not.toContain("0123456789");
    expect(screen.getByRole("searchbox", { name: "Search requests" })).toHaveValue(key);
  });

  it("never puts a custom key typed slowly into the URL or the history, at any length", async () => {
    const seen = recordRequests();
    const { router } = await renderApp("/requests?status=failed");
    await waitForRows();
    const box = screen.getByRole("searchbox", { name: "Search requests" });
    const hrefs = new Set<string>();
    const stop = router.subscribe("onResolved", () => {
      hrefs.add(router.state.location.href);
    });
    const historyBefore = window.history.length;

    // A custom key with no sk- prefix, 24 characters, one every 600 ms: each prefix outlives
    // the 250 ms debounce and is searched on its own.
    const key = "teamalphasecretvalue2026";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let length = 1; length <= key.length; length += 1) {
      fireEvent.change(box, { target: { value: key.slice(0, length) } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      hrefs.add(router.state.location.href);
      hrefs.add(window.location.href);
    }
    vi.useRealTimers();
    stop();

    await waitFor(() => expect(last(seen).get("search")).toBe(key));
    expect(seen.some((params) => params.get("search") === "team")).toBe(true);
    for (const href of hrefs) {
      expect(decodeURIComponent(href)).not.toContain("tea");
      expect(href).not.toContain("search");
    }
    expect(router.state.location.search).toEqual({ status: "failed" });
    expect(window.history.length).toBe(historyBefore);
  });

  it("takes the search from a pasted link once, then cleans it off the URL", async () => {
    const seen = recordRequests();
    const { router } = await renderApp("/requests?search=teamalphasecret&status=failed");
    await waitFor(() => expect(last(seen).get("search")).toBe("teamalphasecret"));
    // The first request already searches: the unfiltered list never loads in between.
    expect(seen.every((params) => params.get("search") === "teamalphasecret")).toBe(true);
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "failed" }));
    expect(router.state.location.href).not.toContain("teamalpha");
    expect(screen.getByRole("searchbox", { name: "Search requests" })).toHaveValue(
      "teamalphasecret",
    );
  });

  it("counts each status in its tab, as Accounts does", async () => {
    await renderApp("/requests");
    await waitForRows();
    const failed = mockDb.requests.filter((record) => !record.success).length;
    const tabs = statusTabs();
    await waitFor(() =>
      expect(within(tabs).getByRole("tab", { name: /^All/ })).toHaveTextContent(
        String(mockDb.requests.length),
      ),
    );
    expect(within(tabs).getByRole("tab", { name: /^Succeeded/ })).toHaveTextContent(
      String(mockDb.requests.length - failed),
    );
    expect(within(tabs).getByRole("tab", { name: /^Failed/ })).toHaveTextContent(String(failed));
  });

  it("filters by failed status", async () => {
    const seen = recordRequests();
    const { user, router } = await renderApp("/requests");
    await waitForRows();
    const tabs = statusTabs();
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: /^Failed/ })).toBeEnabled());
    expect(within(tabs).getByRole("tab", { name: /^All/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(within(tabs).getByRole("tab", { name: /^Failed/ }));
    await waitFor(() => expect(last(seen).get("status")).toBe("failed"));
    expect(router.state.location.search).toEqual({ status: "failed" });
    expect(within(tabs).getByRole("tab", { name: /^Failed/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() => {
      for (const row of bodyRows()) expect(within(row).getByText(/^Failed/)).toBeInTheDocument();
    });
  });

  it("sorts from the Sort by select as a header click would", async () => {
    const seen = recordRequests();
    const { user, router } = await renderApp("/requests?page=2");
    await waitForRows();
    await user.click(screen.getByRole("button", { name: "Sort by: Time" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Credits" }));
    await waitFor(() => expect(last(seen).get("sort")).toBe("credits"));
    expect(last(seen).get("order")).toBe("asc");
    expect(router.state.location.search).toEqual({ sort: "credits", order: "asc" });
    expect(screen.getByRole("button", { name: "Sort by: Credits" })).toBeInTheDocument();
  });

  it("sorts on the server and toggles the order on a second click", async () => {
    const seen = recordRequests();
    const { user, router } = await renderApp("/requests?page=2");
    await waitForRows();

    await user.click(screen.getByRole("button", { name: "Tokens" }));
    await waitFor(() => expect(last(seen).get("sort")).toBe("tokens"));
    expect(last(seen).get("order")).toBe("asc");
    expect(last(seen).get("page")).toBe("1");
    expect(router.state.location.search).toEqual({ sort: "tokens", order: "asc" });

    await user.click(screen.getByRole("button", { name: "Tokens" }));
    await waitFor(() => expect(last(seen).get("order")).toBe("desc"));
    expect(last(seen).get("sort")).toBe("tokens");
  });

  it("writes the next page to the URL", async () => {
    const { user, router } = await renderApp("/requests");
    await waitForRows();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ page: 2 }));
    expect(await screen.findByText("26–50 of 320")).toBeInTheDocument();
  });

  it("changes the page size from the Rows select at the end of the filter row", async () => {
    const seen = recordRequests();
    const { user, router } = await renderApp("/requests?page=2");
    await waitForRows();
    await user.click(screen.getByRole("button", { name: "Rows: 25" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "50" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ pageSize: 50 }));
    await waitFor(() => expect(last(seen).get("pageSize")).toBe("50"));
    expect(last(seen).get("page")).toBe("1");
    await waitForRows(50);
  });

  it("renders a deep-linked page and page size directly", async () => {
    const seen = recordRequests();
    await renderApp("/requests?page=3&pageSize=50");
    await waitForRows(50);
    expect(screen.getByText("101–150 of 320")).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(last(seen).get("page")).toBe("3");
    expect(last(seen).get("pageSize")).toBe("50");
  });

  it("shows a dash for the account and model of an auth failure", async () => {
    await renderApp("/requests");
    await waitForRows();
    const row = bodyRows().find((candidate) =>
      within(candidate).queryByText("Invalid or missing API key"),
    );
    if (!row) throw new Error("auth failure row missing");
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(/^Failed 401/);
    expect(cells[2]).toHaveTextContent(/^—$/);
    // The model cell's first line; the endpoint rides under it as a meta line (ModelCell).
    expect(within(cells[5]).getByText("—")).toBeInTheDocument();
    expect(cells[5]).toHaveTextContent(/^—/);
    expect(within(cells[9]).getByText("Authentication")).toBeInTheDocument();
  });

  it("folds the API key and endpoint columns into their neighbours on narrower lists", async () => {
    await renderApp("/requests");
    await waitForRows();
    // Ten columns overflowed a 1440 px desktop: the key moves under the account below a 68rem
    // container, the endpoint under the model below a 7xl one, and Duration and Error fold under
    // Credits and Status below a 5xl one.
    const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });
    expect(header("API key")).toHaveClass("hidden", "@[68rem]/requests:table-cell");
    expect(header("Endpoint")).toHaveClass("hidden", "@7xl/requests:table-cell");
    expect(header("Duration")).toHaveClass("hidden", "@5xl/requests:table-cell");
    expect(header("Error")).toHaveClass("hidden", "@5xl/requests:table-cell");
    const row = bodyRows().find((candidate) => within(candidate).queryAllByText(/^sk-/).length);
    if (!row) throw new Error("no row with an API key");
    const cells = within(row).getAllByRole("cell");
    expect(within(cells[2]).getByText(/^sk-/)).toHaveClass("@[68rem]/requests:hidden");

    const failed = mockDb.requests
      .slice(0, 25)
      .find((record) => !record.success && record.errorType);
    if (!failed) throw new Error("no failed row with a category");
    const failedRow = bodyRows()[mockDb.requests.indexOf(failed)];
    const status = within(failedRow).getAllByRole("cell")[1];
    expect(status.querySelector("[data-slot=error-type]")).toHaveClass("@5xl/requests:hidden");
  });

  it("renders each request as a list row for narrow containers", async () => {
    await renderApp("/requests");
    await waitForRows();
    const list = screen.getByRole("list", { name: "Requests" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(25);
    const failed = mockDb.requests
      .slice(0, 25)
      .find((record) => !record.success && record.message && record.inTokens === 0);
    if (!failed?.message) throw new Error("no failed row with a message");
    const item = within(list).getAllByRole("listitem")[mockDb.requests.indexOf(failed)];
    expect(item).toHaveTextContent(maskEmailsInText(failed.message));
    expect(item).not.toHaveTextContent(/\btok\b/);
    const success = mockDb.requests.slice(0, 25).findIndex((record) => record.success);
    expect(within(list).getAllByRole("listitem")[success]).toHaveTextContent(/\S+ tok · \S+ cr/);
  });

  it("opens the detail sheet with the full message on row click", async () => {
    const { user } = await renderApp("/requests");
    await waitForRows();
    const failed = mockDb.requests
      .slice(0, 25)
      .filter((record) => !record.success && record.email && record.message)
      .sort((a, b) => (b.message?.length ?? 0) - (a.message?.length ?? 0))[0];
    if (!failed?.message) throw new Error("no failed row with a message");
    const masked = maskEmailsInText(failed.message);

    const row = bodyRows().find((candidate) => within(candidate).queryByText(masked));
    if (!row) throw new Error("row not rendered");
    await user.click(row);

    const dialog = await screen.findByRole("dialog");
    // The model names the request, as a log line's path does.
    expect(
      within(dialog).getByRole("heading", { level: 2, name: failed.model || "Request details" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId("request-message")).toHaveTextContent(masked);
    expect(within(dialog).getByText(String(failed.id))).toBeInTheDocument();
    expect(within(dialog).getByText(failed.accountId)).toBeInTheDocument();
  });

  it("leads a failed request's sheet with the error and drops the duplicate status code", async () => {
    const { user } = await renderApp("/requests?status=failed");
    await waitFor(() => expect(bodyRows().length).toBeGreaterThan(0));
    await user.click(within(bodyRows()[0]).getAllByRole("cell")[4]);
    const dialog = await screen.findByRole("dialog");
    // The sheet title is the dialog's own heading (first); each card is an h2 under it, the
    // numbers card under a screen-reader-only name.
    const headings = within(dialog)
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
      .slice(1);
    expect(headings).toEqual(["Summary", "Request"]);
    // The first failure used no tokens, so there is no token breakdown (a dash in the table).
    expect(within(dialog).queryByText("Cache read")).not.toBeInTheDocument();
    // The error is the notice at the head of the panel, before the numbers and the cards.
    const panel = dialog.querySelector('[data-slot="sheet-panel"]');
    expect(panel?.firstElementChild).toHaveAttribute("data-slot", "alert");
    expect(within(dialog).getByRole("button", { name: "Copy message" })).toBeInTheDocument();
    expect(within(dialog).queryByText("Status code")).not.toBeInTheDocument();
    // The request's ID heads its card as plain text, with no copy button.
    const request = within(dialog).getByRole("region", { name: "Request" });
    expect(within(request).getByText(/^Request ID/).parentElement).toHaveTextContent(/#\d+$/);
    expect(within(dialog).queryByRole("button", { name: "Copy Request ID" })).toBeNull();
  });

  it("splits a request's tokens into input and output with the cache counts", async () => {
    const { user } = await renderApp("/requests?status=success");
    await waitFor(() => expect(bodyRows().length).toBeGreaterThan(0));
    await user.click(within(bodyRows()[0]).getAllByRole("cell")[4]);
    const dialog = await screen.findByRole("dialog");
    const summary = within(dialog).getByRole("region", { name: "Summary" });
    for (const label of ["Duration", "Credits", "Tokens", "Input", "Output", "Cache read"]) {
      expect(within(summary).getByText(label)).toBeInTheDocument();
    }
    // Facts and IDs read label over value, with copy buttons on the account and key IDs.
    const request = within(dialog).getByRole("region", { name: "Request" });
    expect(within(request).getByText("Status code")).toBeInTheDocument();
    expect(within(request).getByRole("button", { name: "Copy Account ID" })).toBeInTheDocument();
  });

  it("opens the account's own sheet over the request, and Escape closes only that", async () => {
    const { user } = await renderApp("/requests?status=success");
    await waitFor(() => expect(bodyRows().length).toBeGreaterThan(0));
    await user.click(within(bodyRows()[0]).getAllByRole("cell")[4]);
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Open account" }));
    // The account sheet loads lazily; while it is open the request sheet under it is inert.
    expect(
      await screen.findByRole("button", { name: "Refresh token" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Refresh token" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    // The lazy sheet alone may take 5 s on a loaded CI runner, so the test needs more than the 5 s default.
  }, 15_000);

  it("offers no account to open for an auth failure", async () => {
    const { user } = await renderApp("/requests");
    await waitForRows();
    const row = bodyRows().find((candidate) =>
      within(candidate).queryByText("Invalid or missing API key"),
    );
    if (!row) throw new Error("auth failure row missing");
    await user.click(within(row).getAllByRole("cell")[4]);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "Request details" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Open account" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy as JSON" })).toBeInTheDocument();
  });

  it("opens the sheet with Enter and steps to the next row", async () => {
    const { user } = await renderApp("/requests");
    await waitForRows();
    const first = mockDb.requests[0];
    const second = mockDb.requests[1];
    bodyRows()[0].focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(String(first.id))).toBeInTheDocument();
    expect(within(dialog).getByText("1 of 25 on this page")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Previous request" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Next request" }));
    expect(await within(dialog).findByText(String(second.id))).toBeInTheDocument();
    expect(within(dialog).getByText("2 of 25 on this page")).toBeInTheDocument();
  });

  it("focuses the sheet itself on open, so one Escape closes it", async () => {
    const { user } = await renderApp("/requests");
    await waitForRows();
    const row = bodyRows()[0];
    row.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    // The first tabbable control is a copy button with a tooltip; it must not take focus.
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(within(dialog).getByRole("button", { name: "Copy Account ID" })).not.toHaveFocus();
    expect(document.querySelector("[data-slot=tooltip-popup]")).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(row).toHaveFocus();
  });

  it("focuses the sheet, not a copy button, when a row is clicked", async () => {
    const { user } = await renderApp("/requests");
    await waitForRows();
    await user.click(within(bodyRows()[0]).getAllByRole("cell")[4]);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveFocus());
  });

  it("opens the search hint on click, so a tap works on touch screens", async () => {
    const { user } = await renderApp("/requests");
    await waitForRows();
    expect(screen.queryByText(/Search also matches the full API key/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "About search" }));
    expect(await screen.findByText(/Search also matches the full API key/)).toBeVisible();
  });

  it("shows the time over a short date in a machine-readable time element", async () => {
    await renderApp("/requests");
    await waitForRows();
    const record = mockDb.requests[0];
    const timeCell = within(bodyRows()[0]).getAllByRole("cell")[0];
    expect(timeCell).toHaveTextContent(formatTime(record.ts, "en"));
    expect(timeCell).toHaveTextContent(formatRowDate(record.ts, "en"));
    expect(timeCell.querySelector("time")).toHaveAttribute(
      "datetime",
      unixToDate(record.ts).toISOString(),
    );
    expect(timeCell.querySelector("[title]")).toBeNull();
  });

  it("masks emails when privacy mode is on", async () => {
    await renderApp("/requests", { privacy: true });
    await waitForRows();
    const emails = [
      ...new Set(
        mockDb.requests
          .slice(0, 25)
          .map((record) => record.email)
          .filter((email): email is string => Boolean(email?.includes("@"))),
      ),
    ];
    expect(emails.length).toBeGreaterThan(0);
    const table = screen.getByRole("table");
    for (const email of emails) {
      expect(table).not.toHaveTextContent(email);
      expect(within(table).getAllByText(maskEmail(email)).length).toBeGreaterThan(0);
    }
  });

  it("shows full emails when privacy mode is off", async () => {
    await renderApp("/requests", { privacy: false });
    await waitForRows();
    const email = mockDb.requests.slice(0, 25).find((record) => record.email)?.email;
    if (!email) throw new Error("no email in the first page");
    expect(within(screen.getByRole("table")).getAllByText(email).length).toBeGreaterThan(0);
  });

  it("shows the memory note for an in-memory response", async () => {
    mockServer.use(inMemoryRequestsHandler());
    await renderApp("/requests");
    await waitForRows();
    expect(
      screen.getByText("Showing the last 200 requests from memory. History is unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByText("1–25 of 200")).toBeInTheDocument();
  });

  it("does not show the memory note for persisted history", async () => {
    await renderApp("/requests");
    await waitForRows();
    expect(screen.queryByText(/from memory/)).not.toBeInTheDocument();
  });

  it("shows No matches with a Clear filters action", async () => {
    const { user, router } = await renderApp("/requests?search=no-such-request&status=failed");
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    // Nothing to page through, so no "0–0 of 0" footer and no disabled Previous/Next.
    expect(screen.queryByText("0–0 of 0")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    // The empty state's action; the toolbar's Clear does the same.
    await user.click(
      screen.getAllByRole("button", { name: "Clear filters" }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitForRows();
    expect(screen.getByRole("searchbox", { name: "Search requests" })).toHaveValue("");
  });

  it("shows the empty state when there are no requests", async () => {
    mockDb.requests = [];
    await renderApp("/requests");
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
    expect(
      screen.getByText("Requests appear here once a client calls the proxy."),
    ).toBeInTheDocument();
    expect(screen.queryByText("0–0 of 0")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
    // Search and the status filter have nothing to narrow yet.
    expect(screen.queryByRole("searchbox", { name: "Search requests" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("offers the first page when the page is out of range", async () => {
    const { user, router } = await renderApp("/requests?page=40");
    expect(await screen.findByText("No requests on this page")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to first page" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitForRows();
  });

  it("shows an error state with retry when the first load fails", async () => {
    let fail = true;
    mockServer.use(
      http.get(RECENT_REQUESTS, () => (fail ? jsonError(500, "database is locked") : undefined)),
    );
    const { user } = await renderApp("/requests");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load requests");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitForRows();
  });

  it("keeps the rows and shows a toast when a refresh fails", async () => {
    let fail = false;
    mockServer.use(
      http.get(RECENT_REQUESTS, () =>
        fail ? HttpResponse.json({ error: "database is locked" }, { status: 500 }) : undefined,
      ),
    );
    const errorToast = vi.spyOn(toast, "error");
    const { user } = await renderApp("/requests");
    await waitForRows();
    fail = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalledTimes(1));
    // The list's own news: never copied into an open detail sheet (modal-notice.tsx).
    expect(errorToast.mock.calls[0]?.[1]).toEqual({ background: true });
    expect(bodyRows()).toHaveLength(25);
  });
});
