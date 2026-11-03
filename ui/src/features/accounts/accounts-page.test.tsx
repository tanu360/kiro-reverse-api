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
    expect(within(table).getByText("Team primary")).toBeInTheDocument();
  });

  it("filters by nickname as the user types", async () => {
    const { table, user } = await renderAccounts();
    await user.type(
      screen.getByRole("searchbox", { name: "Search by email or nickname" }),
      "overfl",
    );
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(within(table).getByText("Overflow")).toBeInTheDocument();
  });

  it("shows only banned accounts under Banned and hides their enabled switch", async () => {
    const { table, user } = await renderAccounts();
    await user.click(screen.getByRole("button", { name: /^Banned/ }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(2));
    expect(within(table).getByText("Banned")).toBeInTheDocument();
    expect(within(table).getByText("Suspended")).toBeInTheDocument();
    expect(within(table).queryByRole("switch")).not.toBeInTheDocument();
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
    expect(within(dialog).getByText("Delete accounts")).toBeInTheDocument();
    expect(
      within(dialog).getByText(`Delete ${ids.length} selected accounts? This cannot be undone.`),
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
      within(dialog).getByText(
        "The account and its usage history are removed. This cannot be undone.",
      ),
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

  it("shows no status counts while the list loads", async () => {
    mockServer.use(http.get(apiUrl("/accounts"), () => new Promise<Response>(() => {})));
    await renderApp("/accounts");
    const group = await screen.findByRole("group", { name: "Account status" });
    const labels = within(group)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual(["All", "Enabled", "Disabled", "Banned"]);
  });

  it("shows no status counts after the list fails to load", async () => {
    mockServer.use(http.get(apiUrl("/accounts"), () => HttpResponse.json({}, { status: 500 })));
    await renderApp("/accounts");
    expect(await screen.findByText("Could not load accounts")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Account status" });
    expect(within(group).getByRole("button", { name: "Banned" })).toHaveTextContent(/^Banned$/);
  });

  it("does not make the overage badge a tab stop", async () => {
    const { table } = await renderAccounts();
    const badges = within(table).getAllByText("Overage");
    expect(badges.length).toBeGreaterThan(0);
    for (const text of badges) {
      const badge = text.parentElement as HTMLElement;
      expect(badge).not.toHaveAttribute("tabindex");
      // The state still reaches screen readers.
      expect(badge).toHaveTextContent(/Overage (enabled|disabled)/);
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
  it("shows cards when the list is narrower than the table, even on a wide viewport", async () => {
    mockElementWidth(900);
    await renderCards();
    expect(screen.queryByRole("table", { name: "Accounts" })).not.toBeInTheDocument();
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

  it("keeps Refresh and Add account in the phone header and moves the rest to a menu", async () => {
    mockViewport(390);
    const { user } = await renderCards();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("button", { name: "Refresh list" })).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: "Add account" })).toBeInTheDocument();
    expect(within(main).queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
    await user.click(within(main).getByRole("button", { name: "More list actions" }));
    expect(await screen.findByRole("menuitem", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refresh all models" })).toBeInTheDocument();
  });
});
