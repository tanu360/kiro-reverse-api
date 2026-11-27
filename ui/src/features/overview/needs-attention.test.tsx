import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { NeedsAttention } from "./needs-attention";

/** The ban reasons the proxy writes (proxy/account_failover.go). */
const AUTH_FAILED = "Authentication failed - token invalid or expired";
const SUSPENDED = "AWS temporarily suspended - unusual user activity detected";

/** A healthy signed-in account from the fixture, changed by `patch`. */
function account(id: string, patch: Partial<Account>): Account {
  const base = mockDb.accounts.find(
    (item) => item.enabled && item.hasToken && item.authMethod !== "api_key",
  );
  if (!base) throw new Error("fixture has no signed-in account");
  return {
    ...base,
    id,
    email: `${id}@example.com`,
    banStatus: "",
    banReason: "",
    silent: false,
    expiresAt: 4_000_000_000,
    usageCurrent: 0,
    usageLimit: 50,
    lastUsed: 0,
    ...patch,
  };
}

const banned = (reason: string): Partial<Account> => ({
  enabled: false,
  banStatus: "BANNED",
  banReason: reason,
});

/** One account per fix: banned three ways, without a token, on an expired token. */
const ACCOUNTS: Account[] = [
  account("auth-ban", { ...banned(AUTH_FAILED), lastUsed: 3 }),
  account("suspension", { ...banned(SUSPENDED), lastUsed: 2 }),
  account("other-ban", { ...banned("AccessDeniedException: access revoked (403)"), lastUsed: 1 }),
  account("no-token", { hasToken: false }),
  account("expired", { expiresAt: 1 }),
];

function serveAccounts(list: () => Account[]): void {
  mockServer.use(http.get(apiUrl("/accounts"), () => HttpResponse.json(list())));
}

async function renderCard() {
  const view = renderWithProviders(<NeedsAttention />, { privacy: false });
  const card = await screen.findByRole("region", { name: "Needs attention" });
  await within(card).findAllByRole("listitem");
  return { ...view, card };
}

/** The list row of the account with this id. */
function row(card: HTMLElement, id: string): HTMLElement {
  const item = within(card).getByText(`${id}@example.com`).closest("li");
  if (!item) throw new Error(`no row for ${id}`);
  return item;
}

describe("NeedsAttention", () => {
  it("offers the fix that works for each problem", async () => {
    serveAccounts(() => ACCOUNTS);
    const { card } = await renderCard();
    const fix = (id: string) => within(row(card, id)).getByRole("button");
    expect(fix("auth-ban")).toHaveAccessibleName("Sign in again");
    // Kiro checks a suspended account again when its token is refreshed.
    expect(fix("suspension")).toHaveAccessibleName("Refresh token");
    expect(fix("other-ban")).toHaveAccessibleName("Details");
    // With no token there is nothing to refresh.
    expect(fix("no-token")).toHaveAccessibleName("Sign in again");
    expect(fix("expired")).toHaveAccessibleName("Refresh token");
  });

  it("names the refresh of a suspended Kiro API key for its usage, as it has no token", async () => {
    serveAccounts(() => [
      account("key-suspension", { ...banned(SUSPENDED), authMethod: "api_key", provider: "" }),
    ]);
    const { card } = await renderCard();
    expect(within(row(card, "key-suspension")).getByRole("button")).toHaveAccessibleName(
      "Refresh usage",
    );
  });

  it("opens Sign in again for the account", async () => {
    serveAccounts(() => ACCOUNTS);
    const { card, user } = await renderCard();
    await user.click(within(row(card, "no-token")).getByRole("button", { name: "Sign in again" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    expect(
      within(dialog).getByText("Sign in again as no-token@example.com.", { exact: false }),
    ).toBeInTheDocument();
  });

  it("says a failed token refresh above the list, and Try again refreshes again", async () => {
    let fail = true;
    const calls: string[] = [];
    mockServer.use(
      http.post(apiUrl("/accounts/:id/refresh"), ({ params }) => {
        calls.push(String(params.id));
        return fail
          ? HttpResponse.json({ error: "boom" }, { status: 500 })
          : HttpResponse.json({ success: true });
      }),
    );
    // Once refreshed, the account is healthy and drops out of the list.
    serveAccounts(() => (fail ? ACCOUNTS : ACCOUNTS.filter((item) => item.id !== "expired")));
    const { card, user } = await renderCard();
    const item = row(card, "expired");
    const fix = within(item).getByRole("button", { name: "Refresh token" });
    await user.click(fix);
    const notice = await within(card).findByRole("alert");
    expect(notice).toHaveTextContent("boom");

    // Close comes back to the row's fix.
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    expect(fix).toHaveFocus();

    await user.click(fix);
    const again = await within(card).findByRole("alert");
    fail = false;
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls).toEqual(["expired", "expired", "expired"]));
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    // The refreshed row leaves the list; focus stays in it, as after a click.
    await waitFor(() => expect(item.isConnected).toBe(false));
    await waitFor(() => expect(card.querySelector("[data-fix]:focus")).not.toBeNull());
  });
});
