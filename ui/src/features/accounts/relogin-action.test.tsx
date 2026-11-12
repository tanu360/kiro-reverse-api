import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { renderApp, renderWithProviders } from "@/test/render";
import { AccountDetailSheet } from "./account-detail-sheet";
import { AccountRowActions, AccountSheetActions } from "./account-row-actions";
import { ReloginProvider } from "./relogin-context";

// One test renders the whole app.
vi.setConfig({ testTimeout: 15_000 });

const DANA = "dana.whitfield@northwind-labs.com";
const DANA_MASKED = "da***@no***.com";

describe("Sign in again", () => {
  it("opens re-login for the menu's own account", async () => {
    const account = mockDb.accounts[1];
    const onRelogin = vi.fn();
    const { user } = renderWithProviders(
      <ReloginProvider onRelogin={onRelogin}>
        <AccountRowActions account={account} onDetails={vi.fn()} onTest={vi.fn()} variant="menu" />
      </ReloginProvider>,
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign in again" }));
    expect(onRelogin).toHaveBeenCalledWith(account);
  });

  it("is in the detail sheet's More menu", async () => {
    const account = mockDb.accounts[0];
    const onRelogin = vi.fn();
    const { user } = renderWithProviders(
      <ReloginProvider onRelogin={onRelogin}>
        <AccountSheetActions account={account} onTest={vi.fn()} />
      </ReloginProvider>,
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign in again" }));
    expect(onRelogin).toHaveBeenCalledWith(account);
  });

  it("hides where nothing can open the dialog", async () => {
    const { user } = renderWithProviders(
      <AccountRowActions
        account={mockDb.accounts[0]}
        onDetails={vi.fn()}
        onTest={vi.fn()}
        variant="menu"
      />,
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Copy JSON" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it("opens from the detail sheet on pages without their own dialog (Overview, Requests)", async () => {
    const account = mockDb.accounts[1];
    const { user } = renderWithProviders(
      <AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />,
    );
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign in again" }));
    expect(await screen.findByRole("dialog", { name: "Sign in again" })).toBeInTheDocument();
  });

  it("opens the add-account dialog in re-login mode from the accounts table", async () => {
    const { user } = await renderApp("/accounts");
    const table = await screen.findByRole("table", { name: "Accounts" });
    const row = (await within(table).findByText(DANA_MASKED)).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign in again" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    // Dana signs in through IAM Identity Center; privacy masks her address here too.
    expect(
      within(dialog).getByRole("heading", { name: "IAM Identity Center (Enterprise SSO)" }),
    ).toBeVisible();
    expect(
      within(dialog).getByText(new RegExp(`Signing ${DANA_MASKED.replace(/[.*]/g, "\\$&")}`)),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(DANA)).not.toBeInTheDocument();
  });
});
