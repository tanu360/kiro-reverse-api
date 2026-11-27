import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { TopAccounts } from "./top-accounts";

/** The card and its table's body rows, once the accounts have loaded. */
async function renderCard() {
  const view = renderWithProviders(<TopAccounts />);
  const card = await screen.findByRole("region", { name: "Accounts" });
  const table = await within(card).findByRole("table", { name: "Accounts" });
  await within(table).findAllByRole("button", { name: "Refresh token" });
  const rows = within(table).getAllByRole("row").slice(1);
  return { ...view, card, rows };
}

describe("TopAccounts", () => {
  it("says a failed token refresh above the rows, and Try again refreshes again", async () => {
    let fail = true;
    const calls: string[] = [];
    mockServer.use(
      http.post(apiUrl("/accounts/:id/refresh"), ({ params }) => {
        calls.push(String(params.id));
        return fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined;
      }),
    );
    const { card, rows, user } = await renderCard();
    const refresh = within(rows[0]).getByRole("button", { name: "Refresh token" });
    await user.click(refresh);
    const notice = await within(card).findByRole("alert");
    expect(notice).toHaveTextContent("boom");

    // Close comes back to the row's button.
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    expect(refresh).toHaveFocus();

    await user.click(refresh);
    const again = await within(card).findByRole("alert");
    fail = false;
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(new Set(calls).size).toBe(1);
    await waitFor(() => expect(within(card).queryByRole("alert")).not.toBeInTheDocument());
    expect(refresh).toHaveFocus();
  });

  it("says a failed delete above the rows, and Try again deletes the account", async () => {
    let fail = true;
    mockServer.use(
      http.delete(apiUrl("/accounts/:id"), () =>
        fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined,
      ),
    );
    const { card, rows, user } = await renderCard();
    const menu = within(rows[0]).getByRole("button", { name: "More actions" });
    await user.click(menu);
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    const notice = await within(card).findByRole("alert");
    expect(notice).toHaveTextContent("boom");

    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows[0].isConnected).toBe(false));
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    // The row's menu went with it: focus is on the next row's menu.
    await waitFor(() =>
      expect(within(rows[1]).getByRole("button", { name: "More actions" })).toHaveFocus(),
    );
  });

  it("reads Cooling down for an active account the pool skips, as the Accounts page does", async () => {
    const base = mockDb.accounts.find(
      (item) => item.enabled && item.hasToken && item.authMethod !== "api_key",
    );
    if (!base) throw new Error("fixture has no signed-in account");
    const cooling: Account = {
      ...base,
      id: "cooling",
      banStatus: "",
      banReason: "",
      silent: false,
      expiresAt: 4_000_000_000,
      usageCurrent: 0,
      usageLimit: 50,
    };
    mockServer.use(
      http.get(apiUrl("/accounts"), () => HttpResponse.json([cooling])),
      http.get(apiUrl("/observe/account-activity"), () =>
        HttpResponse.json({
          nowUnix: 1_800_000_000,
          dayStartUnix: 1_799_990_000,
          rpmLimit: 0,
          accounts: { cooling: { today: 4, rpm: 0, atLimit: false, cooldownUntil: 1_800_000_045 } },
        }),
      ),
    );
    const { rows } = await renderCard();
    expect(
      await within(rows[0]).findByRole("button", { name: /^Cooling down/ }),
    ).toBeInTheDocument();
    expect(within(rows[0]).queryByText("Active")).not.toBeInTheDocument();
  });
});
