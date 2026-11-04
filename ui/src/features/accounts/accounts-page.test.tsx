import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";

const DANA = "dana.whitfield@northwind-labs.com";
const DANA_MASKED = "da***@no***.com";

/** Records the JSON body of every matching request, then lets the feature mock answer it. */
function captureBodies(method: "post" | "put" | "delete", path: string): unknown[] {
  const bodies: unknown[] = [];
  mockServer.use(
    http[method](apiUrl(path), async ({ request }) => {
      bodies.push(method === "delete" ? null : await request.clone().json());
      return undefined;
    }),
  );
  return bodies;
}

async function renderAccounts(path = "/accounts") {
  const view = await renderApp(path);
  const table = await screen.findByRole("table", { name: "Accounts" });
  await within(table).findByText(DANA_MASKED);
  return { ...view, table };
}

function bodyRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole("row").slice(1);
}

const spies: MockInstance[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Answers width media queries as a viewport of `width` px would (no pointer queries). */
function mockViewport(width: number): void {
  spies.push(
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      const min = /min-width:\s*(\d+)px/.exec(query);
      const matches =
        !query.includes("pointer") &&
        (!max || width <= Number(max[1])) &&
        (!min || width >= Number(min[1]));
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    }),
  );
}

/** Gives every element a layout box `width` px wide (jsdom has no layout). */
function mockElementWidth(width: number): void {
  spies.push(
    vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ width, height: 40 })),
  );
}

async function renderCards(path = "/accounts") {
  const view = await renderApp(path);
  const list = await screen.findByRole("list", { name: "Accounts" });
  await within(list).findByText(DANA_MASKED);
  return { ...view, list };
}

describe("AccountsPage", () => {
  it("renders one row per account with emails masked under privacy", async () => {
    const { table } = await renderAccounts();
    expect(bodyRows(table)).toHaveLength(mockDb.accounts.length);
    expect(screen.queryByText(DANA)).not.toBeInTheDocument();
    // Nickname, plan and sign-in method share one quiet line under the email.
    expect(within(table).getByText("Team primary · Pro · Enterprise")).toBeInTheDocument();
  });

  it("shows exactly one status pill per row, worst state first", async () => {
    const { table } = await renderAccounts();
    for (const row of bodyRows(table)) {
      expect(row.querySelectorAll("[data-status]")).toHaveLength(1);
    }
    // Banned and out of credits: the ban wins.
    const banned = within(table).getByText("Banned").closest("tr") as HTMLElement;
    expect(within(banned).queryByText("Out of credits")).not.toBeInTheDocument();
    expect(within(table).getByText("Token expired")).toBeInTheDocument();
  });

  it("filters by nickname as the user types", async () => {
    const { table, user } = await renderAccounts();
    await user.type(
      screen.getByRole("searchbox", { name: "Search by email or nickname" }),
      "overfl",
    );
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(within(table).getByText(/^Overflow ·/)).toBeInTheDocument();
  });

  it("filters by the status in the URL and hides a banned account's switch", async () => {
    await renderApp("/accounts?status=banned");
    const table = await screen.findByRole("table", { name: "Accounts" });
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(within(table).getByText("Banned")).toBeInTheDocument();
    expect(within(table).queryByRole("switch")).not.toBeInTheDocument();
  });

  it("groups the problem statuses under Needs attention and narrows them with Issue", async () => {
    const { table, user, router } = await renderAccounts();
    const tabs = screen.getByRole("tablist", { name: "Account status" });
    expect(within(tabs).getByRole("tab", { name: /^All/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(within(tabs).getByRole("tab", { name: /^Needs attention/ }));
    expect(router.state.location.search).toMatchObject({ status: "attention" });
    await waitFor(() => expect(bodyRows(table).length).toBeLessThan(mockDb.accounts.length));
    for (const row of bodyRows(table)) {
      expect(within(row).queryByText("Active")).not.toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: "Issue: All" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^Suspended/ }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(router.state.location.search).toMatchObject({ status: "suspended" });
    expect(screen.getByText(`1 of ${mockDb.accounts.length}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(mockDb.accounts.length));
    expect(router.state.location.search).not.toHaveProperty("status");
  });

  it("opens an old single-status link on the Needs attention tab", async () => {
    await renderApp("/accounts?status=banned");
    const tabs = await screen.findByRole("tablist", { name: "Account status" });
    expect(within(tabs).getByRole("tab", { name: /^Needs attention/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Issue: Banned" })).toBeInTheDocument();
  });

  it("filters by plan from its Label: Value select and clears it from All", async () => {
    const { table, user, router } = await renderAccounts();
    await user.click(screen.getByRole("button", { name: "Plan: All" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^Power/ }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(router.state.location.search).toMatchObject({ plan: "power" });
    // The first menu must finish closing, or its rows answer the next query.
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Plan: Power" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^All/ }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(mockDb.accounts.length));
    expect(router.state.location.search).not.toHaveProperty("plan");
  });

  it("sorts from the Sort by select as a header click would", async () => {
    const { table, user, router } = await renderAccounts();
    await user.click(screen.getByRole("button", { name: "Sort by: Default" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Requests" }));
    const header = within(table).getByRole("columnheader", { name: "Requests" });
    await waitFor(() => expect(header).toHaveAttribute("aria-sort", "descending"));
    expect(router.state.location.search).toMatchObject({ sort: "requests", order: "desc" });
    expect(screen.getByRole("button", { name: "Sort by: Requests" })).toBeInTheDocument();
  });

  it("sorts from a column header, most requests first, and keeps the sort in the URL", async () => {
    const { table, user, router } = await renderAccounts();
    const header = within(table).getByRole("columnheader", { name: "Requests" });
    await user.click(within(header).getByRole("button"));
    await waitFor(() => expect(header).toHaveAttribute("aria-sort", "descending"));
    expect(router.state.location.search).toMatchObject({ sort: "requests", order: "desc" });
    const top = [...mockDb.accounts].sort((a, b) => b.requestCount - a.requestCount)[0];
    expect(within(bodyRows(table)[0]).getByText(new RegExp(`^${top.nickname} ·`))).toBeVisible();
  });

  it("opens the details sheet from a click on the row", async () => {
    const { table, user } = await renderAccounts();
    const row = within(table).getByText(DANA_MASKED).closest("tr") as HTMLElement;
    await user.click(within(row).getAllByRole("cell")[2]);
    const sheet = await screen.findByRole("dialog", { name: "Account details" });
    expect(within(sheet).getByText("Active")).toBeInTheDocument();
  });

  it("keeps the selection across filters and batch-deletes it after a confirm", async () => {
    const bodies = captureBodies("post", "/accounts/batch");
    const { table, user } = await renderAccounts();
    const ids = mockDb.accounts.map((account) => account.id);

    await user.click(within(table).getByRole("checkbox", { name: "Select all" }));
    expect(await screen.findByText(`${ids.length} selected`)).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search by email or nickname" }),
      "overfl",
    );
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(screen.getByText(`${ids.length} selected`)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(`Delete ${ids.length} accounts?`)).toBeInTheDocument();
    expect(
      within(dialog).getByText("Usage history is removed as well. This cannot be undone."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(`Deleted ${ids.length} accounts, 0 failed.`),
    ).toBeInTheDocument();
    expect(bodies).toEqual([{ ids, action: "delete" }]);
    await waitFor(() => expect(screen.queryByText(/ selected$/)).not.toBeInTheDocument());
  });

  it("sends PUT {enabled:false} when the switch is turned off", async () => {
    const bodies = captureBodies("put", "/accounts/:id");
    const { user } = await renderAccounts();
    const toggle = screen.getByRole("switch", { name: `Enable ${DANA_MASKED}` });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(bodies).toEqual([{ enabled: false }]));
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("asks before deleting an account and sends nothing on Cancel", async () => {
    const bodies = captureBodies("delete", "/accounts/:id");
    const { table, user } = await renderAccounts();
    const row = within(table).getByText(DANA_MASKED).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete this account?")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Usage history is removed as well. This cannot be undone."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([]);
    expect(bodyRows(table)).toHaveLength(mockDb.accounts.length);
  });

  it("shows the empty state and opens Add account from it", async () => {
    mockServer.use(http.get(apiUrl("/accounts"), () => HttpResponse.json([])));
    const { user, router } = await renderApp("/accounts");
    const title = await screen.findByText("No accounts yet");
    expect(screen.getByText("Add an account to start serving requests.")).toBeInTheDocument();
    const empty = title.closest('[data-slot="empty"]') as HTMLElement;
    await user.click(within(empty).getByRole("button", { name: "Add account" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ add: true }));
  });

  it("offers no filters while the list loads: zero counts would read as an empty fleet", async () => {
    mockServer.use(http.get(apiUrl("/accounts"), () => new Promise<Response>(() => {})));
    await renderApp("/accounts?status=banned&plan=power");
    expect(
      await screen.findByRole("searchbox", { name: "Search by email or nickname" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Account status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Plan:/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/ of 0$/)).not.toBeInTheDocument();
  });

  it("hides the toolbar after the list fails to load", async () => {
    mockServer.use(http.get(apiUrl("/accounts"), () => HttpResponse.json({}, { status: 500 })));
    await renderApp("/accounts");
    expect(await screen.findByText("Could not load accounts")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("shows weight and overage as quiet icons that are not tab stops", async () => {
    const { table } = await renderAccounts();
    for (const label of ["Weight 3", "Overage enabled"]) {
      const text = within(table).getByText(label);
      expect(text).toHaveClass("sr-only");
      expect(text.parentElement).not.toHaveAttribute("tabindex");
    }
  });

  it("names the plan meter only for screen readers in the table, under its column header", async () => {
    const { table } = await renderAccounts();
    const row = within(table).getByText(DANA_MASKED).closest("tr") as HTMLElement;
    expect(within(row).getByText("Plan credits")).toHaveClass("sr-only");
    expect(within(row).getByText("450 / 1,000")).toBeInTheDocument();
  });
});

describe("AccountsPage layout", () => {
  it("shows cards when the list is narrower than md, even on a wide viewport", async () => {
    mockElementWidth(700);
    await renderCards();
    expect(screen.queryByRole("table", { name: "Accounts" })).not.toBeInTheDocument();
  });

  it("keeps the table on a laptop-width list (1366 px window, sidebar open)", async () => {
    mockElementWidth(976);
    const { table } = await renderAccounts();
    expect(screen.queryByRole("list", { name: "Accounts" })).not.toBeInTheDocument();
    // jsdom has no container queries, so check the classes that hide the columns under 1,100 px.
    const header = (name: string) => within(table).getByRole("columnheader", { name });
    expect(header("Requests")).toHaveClass("hidden", "@[900px]/accounts:table-cell");
    for (const name of ["Last used", "Token expiry"]) {
      expect(header(name)).toHaveClass("hidden", "@[1100px]/accounts:table-cell");
    }
    for (const name of ["Account", "Status", "Usage", "Enabled"]) {
      expect(header(name)).not.toHaveClass("hidden");
    }
    // The list is the query container those classes name.
    expect(table.closest(".\\@container\\/accounts")).not.toBeNull();
    // Row actions stay pinned to the right edge.
    const actions = within(bodyRows(table)[0]).getAllByRole("cell").at(-1) as HTMLElement;
    expect(actions).toHaveClass("sticky", "right-0");
  });

  it("shows the table when the list has room for every column", async () => {
    mockElementWidth(1200);
    await renderAccounts();
    expect(screen.queryByRole("list", { name: "Accounts" })).not.toBeInTheDocument();
  });

  it("selects a card from anywhere in its 40 px checkbox square", async () => {
    mockViewport(390);
    const { list, user } = await renderCards();
    const checkbox = within(list).getByRole("checkbox", { name: `Select ${DANA_MASKED}` });
    const square = checkbox.closest("label") as HTMLElement;
    expect(square).toHaveClass("size-10");
    await user.click(square);
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    expect(checkbox).toBeChecked();
  });

  it("puts the batch bar after the list, sticky, with phone-sized actions and a menu", async () => {
    mockViewport(390);
    const bodies = captureBodies("post", "/accounts/batch");
    const { list, user } = await renderCards();
    const checkboxes = within(list).getAllByRole("checkbox");
    await user.click(checkboxes[checkboxes.length - 1]);

    const bar = await screen.findByRole("region", { name: "Batch actions" });
    // After the list in the DOM, so `sticky bottom-*` keeps it in view while the list scrolls.
    expect(list.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(bar.className).toMatch(/(^|\s)bottom-/);
    for (const name of ["Enable", "Disable"]) {
      expect(within(bar).getByRole("button", { name })).toHaveClass("h-10");
    }
    expect(within(bar).getByRole("button", { name: "More batch actions" })).toHaveClass("size-10");

    await user.click(within(bar).getByRole("button", { name: "More batch actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete selected" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it("folds Export and Refresh all models into a ⋯ menu on phones", async () => {
    mockViewport(390);
    const { user } = await renderCards();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: "Add account" })).toBeInTheDocument();
    expect(within(main).queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
    // The cards have no headers to click; the Sort by select stands in.
    expect(within(main).getByRole("button", { name: "Sort by: Default" })).toBeInTheDocument();
    await user.click(within(main).getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refresh all models" })).toBeInTheDocument();
  });

  it("shows each header action as its own button on wider screens", async () => {
    await renderAccounts();
    const main = screen.getByRole("main");
    const header = main.querySelector('[data-slot="page-header-actions"]') as HTMLElement;
    const names = within(header)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names).toEqual(["Refresh", "Refresh all models", "Export", "Add account"]);
    expect(within(header).queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });
});
