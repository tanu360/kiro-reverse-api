import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { maskEmailsInText } from "@/lib/privacy";
import { renderApp } from "@/test/render";

// The whole app renders per test, and DataTable renders the rows twice (table and cards, one
// hidden by a container query), so a busy run needs more than the 5 s default.
vi.setConfig({ testTimeout: 15_000 });

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
      screen.getByRole("searchbox", { name: "Search email, nickname, notes, tags" }),
      "overfl",
    );
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(within(table).getByText(/^Overflow ·/)).toBeInTheDocument();
  });

  it("filters by the status in the URL and locks a banned account's switch", async () => {
    await renderApp("/accounts?status=banned");
    const table = await screen.findByRole("table", { name: "Accounts" });
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(within(table).getByText("Banned")).toBeInTheDocument();
    // The switch stays in its column, locked, so every row lines up.
    expect(within(table).getByRole("switch")).toHaveAttribute("aria-disabled", "true");
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
    // The sheet is titled with the clicked account's (masked) email, so this proves the row
    // opened its own account's details, not another row's or another dialog.
    expect(await screen.findByRole("dialog", { name: DANA_MASKED })).toBeInTheDocument();
  });

  it("keeps the selection across filters and batch-deletes it after a confirm", async () => {
    const bodies = captureBodies("post", "/accounts/batch");
    const { table, user } = await renderAccounts();
    const ids = mockDb.accounts.map((account) => account.id);

    await user.click(within(table).getByRole("checkbox", { name: "Select all" }));
    expect(await screen.findByText(`${ids.length} selected`)).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search email, nickname, notes, tags" }),
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
    const { table, user } = await renderAccounts();
    const toggle = within(table).getByRole("switch", { name: `Enable ${DANA_MASKED}` });
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
    expect(within(dialog).getByText(`Delete ${DANA_MASKED}?`)).toBeInTheDocument();
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
      await screen.findByRole("searchbox", { name: "Search email, nickname, notes, tags" }),
    ).toBeInTheDocument();
    // The tabs hold their place, disabled and without counts, so the table does not shift.
    const tabs = screen.getByRole("tablist", { name: "Account status" });
    for (const tab of within(tabs).getAllByRole("tab")) {
      expect(tab).toHaveAttribute("aria-disabled", "true");
      expect(tab).not.toHaveTextContent(/\d/);
    }
    expect(screen.queryByRole("button", { name: /^Plan:/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/ of 0$/)).not.toBeInTheDocument();
  });

  it("shows Clear and the result count for a refinement, not for a status tab alone", async () => {
    const { user } = await renderAccounts();
    const tabs = screen.getByRole("tablist", { name: "Account status" });
    await user.click(within(tabs).getByRole("tab", { name: /^Active/ }));
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(` of ${mockDb.accounts.length}$`)),
    ).not.toBeInTheDocument();
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
  it("switches between the table and the cards on the table's own width", async () => {
    const { container } = await renderAccounts();
    // jsdom has no container queries: check the classes that pick one view under 42rem.
    const cards = container.querySelector('[data-slot="data-table-cards"]') as HTMLElement;
    expect(cards).toHaveClass("@2xl/data-table:hidden");
    const view = container.querySelector('[data-slot="data-table-view"]') as HTMLElement;
    expect(view).toHaveClass("hidden", "@2xl/data-table:block");
    // The cards are rows divided inside the one card, not cards in a card.
    expect(within(cards).getByRole("list", { name: "Accounts" })).toHaveClass("divide-y");
  });

  it("hides the low-priority columns on a narrower table and pins the row actions", async () => {
    const { table } = await renderAccounts();
    const header = (name: string) => within(table).getByRole("columnheader", { name });
    expect(header("Requests")).toHaveClass("hidden", "@4xl/data-table:table-cell");
    expect(header("Last used")).toHaveClass("hidden", "@5xl/data-table:table-cell");
    expect(header("Token expiry")).toHaveClass("hidden", "@6xl/data-table:table-cell");
    for (const name of ["Account", "Status", "Usage", "Enabled"]) {
      expect(header(name)).not.toHaveClass("hidden");
    }
    const actions = within(bodyRows(table)[0]).getAllByRole("cell").at(-1) as HTMLElement;
    expect(actions).toHaveClass("sticky", "right-0");
  });

  it("selects a card from its checkbox and opens details from the card", async () => {
    const { list, user } = await renderCards();
    const checkbox = within(list).getByRole("checkbox", { name: `Select ${DANA_MASKED}` });
    await user.click(checkbox);
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    expect(checkbox).toBeChecked();
    await user.click(within(list).getByRole("button", { name: `Open details for ${DANA_MASKED}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("puts the batch toolbar after the list, sticky, with a menu for the rest on phones", async () => {
    mockViewport(390);
    const bodies = captureBodies("post", "/accounts/batch");
    const { list, user } = await renderCards();
    const checkboxes = within(list).getAllByRole("checkbox");
    await user.click(checkboxes[checkboxes.length - 1]);

    const bar = await screen.findByRole("toolbar", { name: "Batch actions" });
    // After the list in the DOM, so `sticky bottom-*` keeps it in view while the list scrolls.
    expect(list.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar).toHaveAttribute("data-slot", "batch-bar");
    expect(bar.className).toMatch(/(^|\s)sticky(\s|$)/);
    for (const name of ["Enable selected", "Disable selected"]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }

    await user.click(within(bar).getByRole("button", { name: "More batch actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete selected" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it("refreshes the selection's models in one batch call and reports the result", async () => {
    // The third account fails upstream: the toast counts it and names it with the reason.
    mockServer.use(
      http.post(apiUrl("/accounts/batch"), async ({ request }) => {
        const { ids } = (await request.clone().json()) as { ids: string[] };
        return HttpResponse.json({
          success: true,
          refreshed: ids.length - 1,
          failed: 1,
          models: 12,
          results: ids.map((id, index) =>
            index === ids.length - 1 ? { id, ok: false, error: "upstream 500" } : { id, ok: true },
          ),
        });
      }),
    );
    const bodies = captureBodies("post", "/accounts/batch");
    const { table, user } = await renderAccounts();
    const rows = bodyRows(table).slice(0, 3);
    for (const row of rows) await user.click(within(row).getAllByRole("checkbox")[0]);
    const bar = await screen.findByRole("toolbar", { name: "Batch actions" });
    await user.click(within(bar).getByRole("button", { name: "Refresh models" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Refresh models" }));
    const title = await screen.findByText("Refreshed models for 2 accounts, 1 failed.");
    const toastRoot = title.closest<HTMLElement>('[data-slot="toast"]');
    expect(toastRoot).toHaveAttribute("data-type", "warning");
    expect(toastRoot?.querySelector('[data-slot="toast-description"]')?.textContent).toMatch(
      /: upstream 500$/,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ action: "refreshModels" });
    expect((bodies[0] as { ids: string[] }).ids).toHaveLength(3);
  });

  it("exports the selection from the batch toolbar with only those accounts checked", async () => {
    const { table, user } = await renderAccounts();
    await user.click(within(bodyRows(table)[0]).getAllByRole("checkbox")[0]);
    const bar = await screen.findByRole("toolbar", { name: "Batch actions" });
    await user.click(within(bar).getByRole("button", { name: "Export selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Export accounts" });
    expect(within(dialog).getByText("1 selected")).toBeInTheDocument();
  });

  it("shows a short Refresh models label on phones and Export in the tab row", async () => {
    mockViewport(390);
    await renderCards();
    const main = screen.getByRole("main");
    const header = main.querySelector('[data-slot="page-header-actions"]') as HTMLElement;
    // One refresh only (Refresh models); the list refetches on its own.
    const names = within(header)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names).toEqual(["Refresh models", "Add account"]);
    expect(within(header).getByText("Models")).toHaveClass("sm:hidden");
    // The cards have no headers to click; the Sort by select stands in.
    expect(within(main).getByRole("button", { name: "Sort by: Default" })).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("puts Export at the end of the status tab row, not in the header", async () => {
    await renderAccounts();
    const main = screen.getByRole("main");
    const header = main.querySelector('[data-slot="page-header-actions"]') as HTMLElement;
    const names = within(header)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names).toEqual(["Refresh models", "Add account"]);
    const toolbar = main.querySelector('[data-slot="accounts-toolbar"]') as HTMLElement;
    const exportButton = await within(toolbar).findByRole("button", { name: "Export" });
    // Outside the tablist, so the tabs keep their arrow-key order.
    expect(within(screen.getByRole("tablist")).queryByRole("button")).not.toBeInTheDocument();
    expect(exportButton).toBeInTheDocument();
  });

  it("shows only the empty state inside the card when there are no accounts", async () => {
    mockServer.use(http.get(apiUrl("/accounts"), () => HttpResponse.json([])));
    await renderApp("/accounts");
    await screen.findByText("No accounts yet");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh models" })).not.toBeInTheDocument();
  });
});

describe("AccountsPage tags", () => {
  function tagFixtures() {
    const dana = mockDb.accounts.find((account) => account.email === DANA);
    const other = mockDb.accounts.find((account) => account.email !== DANA);
    if (!dana || !other) throw new Error("fixture missing");
    dana.tags = ["Team-A", "backup", "ci"];
    dana.notes = "Rotate before the audit";
    other.tags = ["team-a"];
    return { dana, other };
  }

  it("shows tag badges, filters by a tag in the URL and clears it from the Tag select", async () => {
    tagFixtures();
    const { table, user, router } = await renderAccounts("/accounts?tag=TEAM-A");
    await waitFor(() => expect(bodyRows(table)).toHaveLength(2));
    const danaRow = bodyRows(table).find((row) => within(row).queryByText(DANA_MASKED));
    if (!danaRow) throw new Error("dana row missing");
    // Two tags show, the third folds into +1.
    expect(within(danaRow).getByText("Team-A")).toBeInTheDocument();
    expect(within(danaRow).getByText("backup")).toBeInTheDocument();
    expect(within(danaRow).getByText("+1")).toBeInTheDocument();
    expect(within(danaRow).getByText("1 more tag: ci")).toHaveClass("sr-only");

    await user.click(screen.getByRole("button", { name: "Tag: Team-A" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^All/ }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(mockDb.accounts.length));
    expect(router.state.location.search).not.toHaveProperty("tag");
  });

  it("filters by a tag named All without mistaking it for the All row", async () => {
    const { dana } = tagFixtures();
    dana.tags = ["All"];
    const { table, user, router } = await renderAccounts();
    await user.click(screen.getByRole("button", { name: "Tag: All" }));
    const rows = await screen.findAllByRole("menuitemradio", { name: /^All/ });
    // The All row and the tag: only the All row is checked while no tag is picked.
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.getAttribute("aria-checked") === "true")).toHaveLength(1);
    await user.click(rows[1]);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tag: "all" }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    // The picked tag is quoted, so the trigger never reads like the unfiltered state.
    expect(screen.getByRole("button", { name: "Tag: “All”" })).toBeInTheDocument();
  });

  it("masks an email inside a tag in the Tag select under privacy", async () => {
    const { dana } = tagFixtures();
    dana.tags = ["ops@example.com"];
    const masked = maskEmailsInText("ops@example.com");
    const { user } = await renderAccounts("/accounts?tag=ops@example.com");
    const trigger = await screen.findByRole("button", { name: `Tag: ${masked}` });
    await user.click(trigger);
    expect(
      await screen.findByRole("menuitemradio", { name: (name) => name.startsWith(masked) }),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("ops@example.com");
  });

  it("finds an account by a word of its notes", async () => {
    tagFixtures();
    const { table, user } = await renderAccounts();
    await user.type(
      screen.getByRole("searchbox", { name: "Search email, nickname, notes, tags" }),
      "audit",
    );
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(within(table).getByText(DANA_MASKED)).toBeInTheDocument();
  });

  it("adds a tag to the selection from the batch toolbar and clears the selection", async () => {
    const bodies = captureBodies("post", "/accounts/batch");
    const { table, user } = await renderAccounts();
    const rows = bodyRows(table).slice(0, 2);
    for (const row of rows) await user.click(within(row).getAllByRole("checkbox")[0]);
    const bar = await screen.findByRole("toolbar", { name: "Batch actions" });
    await user.click(within(bar).getByRole("button", { name: "Tags" }));
    const dialog = await screen.findByRole("dialog", { name: "Tag 2 accounts" });
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "vip{Enter}");
    expect(await screen.findByText("Tagged 2 accounts.")).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ action: "addTag", tag: "vip" });
    await waitFor(() => expect(screen.queryByText(/ selected$/)).not.toBeInTheDocument());
    await waitFor(() => expect(within(table).getAllByText("vip")).toHaveLength(2));
  });

  it("offers Tags in the phone batch menu", async () => {
    mockViewport(390);
    const { list, user } = await renderCards();
    tagFixtures();
    const checkboxes = within(list).getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    const bar = await screen.findByRole("toolbar", { name: "Batch actions" });
    await user.click(within(bar).getByRole("button", { name: "More batch actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Tags" }));
    expect(await screen.findByRole("dialog", { name: "Tag 1 account" })).toBeInTheDocument();
  });
});
