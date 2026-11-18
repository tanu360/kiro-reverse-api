import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { attentionRows, NeedsAttention } from "./needs-attention";

/** The first row whose fix is a token refresh, within the five the card shows. */
function refreshableRow(): { index: number; id: string } {
  const rows = attentionRows(mockDb.accounts, Date.now() / 1000);
  const index = rows.findIndex((row) => ["expired", "noToken", "suspended"].includes(row.status));
  if (index < 0 || index >= 5) throw new Error("fixture has no refreshable account in view");
  return { index, id: rows[index].account.id };
}

describe("NeedsAttention", () => {
  it("says a failed token refresh above the list, and Try again refreshes again", async () => {
    const { index, id } = refreshableRow();
    let fail = true;
    const calls: string[] = [];
    mockServer.use(
      http.post(apiUrl("/accounts/:id/refresh"), ({ params }) => {
        calls.push(String(params.id));
        return fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined;
      }),
      // Once refreshed, the account is healthy and drops out of the list.
      http.get(apiUrl("/accounts"), () =>
        HttpResponse.json(
          fail ? mockDb.accounts : mockDb.accounts.filter((account) => account.id !== id),
        ),
      ),
    );
    const { user } = renderWithProviders(<NeedsAttention />);
    const card = await screen.findByRole("region", { name: "Needs attention" });
    const items = await within(card).findAllByRole("listitem");
    const fix = within(items[index]).getByRole("button", { name: "Refresh token" });
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
    await waitFor(() => expect(calls).toEqual([id, id, id]));
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    // The refreshed row leaves the list; focus stays in it, as after a click.
    await waitFor(() => expect(items[index].isConnected).toBe(false));
    await waitFor(() => expect(card.querySelector("[data-fix]:focus")).not.toBeNull());
  });
});
