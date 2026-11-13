import { screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AccountDetailSheet } from "../account-detail-sheet";

function dana(): Account {
  const account = mockDb.accounts.find((a) => a.email.startsWith("dana."));
  if (!account) throw new Error("fixture missing");
  return account;
}

function capturePuts(): unknown[] {
  const bodies: unknown[] = [];
  mockServer.use(
    http.put(apiUrl("/accounts/:id"), async ({ request }) => {
      bodies.push(await request.clone().json());
      return undefined;
    }),
  );
  return bodies;
}

async function openPriorityEditor(account: Account) {
  const view = renderWithProviders(
    <AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />,
  );
  const sheet = await screen.findByRole("dialog");
  await within(sheet).findByRole("region", { name: "Account" });
  await view.user.click(within(sheet).getByRole("button", { name: "Edit Priority" }));
  const input = await within(sheet).findByRole("textbox", { name: "Priority" });
  return { ...view, sheet, input };
}

describe("PriorityRow", () => {
  it("shows the saved priority and its hint", async () => {
    const account = dana();
    account.priority = 12;
    const { sheet, input } = await openPriorityEditor(account);
    expect(input).toHaveValue("12");
    expect(
      within(sheet).getByText(/In priority routing, a lower number gets new requests first/),
    ).toBeInTheDocument();
  });

  it("saves the priority as a JSON number and closes the edit", async () => {
    const puts = capturePuts();
    const account = dana();
    const { user, sheet, input } = await openPriorityEditor(account);
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "4{Enter}");
    await waitFor(() => expect(puts).toEqual([{ priority: 4 }]));
    expect(await screen.findByText("The change was saved.")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(sheet).getByRole("button", { name: "Edit Priority" })).toHaveFocus(),
    );
    expect(mockDb.accounts.find((a) => a.id === account.id)?.priority).toBe(4);
  });

  it("clamps a priority above 999 before sending it", async () => {
    const puts = capturePuts();
    const { user, input } = await openPriorityEditor(dana());
    await user.clear(input);
    await user.type(input, "5000{Enter}");
    await waitFor(() => expect(puts).toEqual([{ priority: 999 }]));
  });
});
