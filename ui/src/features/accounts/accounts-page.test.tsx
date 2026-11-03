import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
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
});
