import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Account, ApiKey, RoutingMode } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { AccountDetailSheet } from "../account-detail-sheet";

function dana(): Account {
  const account = mockDb.accounts.find((a) => a.email.startsWith("dana."));
  if (!account) throw new Error("fixture missing");
  return account;
}

async function renderSheet(
  mode: RoutingMode,
  keyModes: Array<"inherit" | RoutingMode> = [],
  keyOverrides: Partial<ApiKey> = {},
) {
  mockDb.settings = { ...mockDb.settings, routingMode: mode, requireApiKey: true };
  mockDb.apiKeys = mockDb.apiKeys.map((key, i) => ({
    ...key,
    enabled: true,
    accountIds: [],
    accountTags: [],
    expired: false,
    expiresAt: 0,
    routingMode: keyModes[i] ?? "inherit",
    ...keyOverrides,
  }));
  const account = dana();
  account.weight = 4;
  account.priority = 12;
  renderWithProviders(<AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />);
  const sheet = await screen.findByRole("dialog");
  const section = await within(sheet).findByRole("region", { name: "Account" });
  return section;
}

describe("weight and priority under the routing mode", () => {
  it("says the priority is not used while routing is weighted", async () => {
    const section = await renderSheet("weighted");
    expect(
      await within(section).findByText("Not used while routing is Weighted"),
    ).toBeInTheDocument();
    expect(
      within(section).queryByText("Not used while routing is Priority"),
    ).not.toBeInTheDocument();
  });

  it("says the weight is not used while routing is by priority", async () => {
    const section = await renderSheet("priority");
    expect(
      await within(section).findByText("Not used while routing is Priority"),
    ).toBeInTheDocument();
  });

  it("counts an API key's own routing mode as in use", async () => {
    const section = await renderSheet("priority", ["weighted"]);
    await within(section).findByText("12");
    expect(within(section).queryByText(/^Not used while routing is/)).not.toBeInTheDocument();
  });

  it("leaves out a key whose accounts do not include this one (config.ApiKeyAllowedAccounts)", async () => {
    const section = await renderSheet("priority", ["weighted"], { accountIds: ["someone-else"] });
    expect(
      await within(section).findByText("Not used while routing is Priority"),
    ).toBeInTheDocument();
  });

  it("counts a key that reaches this account by tag", async () => {
    dana().tags = ["Team-A"];
    const section = await renderSheet("priority", ["weighted"], {
      accountIds: ["someone-else"],
      accountTags: ["team-a"],
    });
    await within(section).findByText("12");
    expect(within(section).queryByText(/^Not used while routing is/)).not.toBeInTheDocument();
  });

  it("leaves out an expired key: its clients get 401", async () => {
    const section = await renderSheet("priority", ["weighted"], { expired: true, expiresAt: 1 });
    expect(
      await within(section).findByText("Not used while routing is Priority"),
    ).toBeInTheDocument();
  });
});
