import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AddAccountDialog, type AddAccountMethod } from "./add-account-dialog";

interface RequestLog {
  count: number;
  bodies: Array<Record<string, unknown>>;
}

/** Records every POST to `path`, then lets the feature mock answer it. */
function logRequests(path: string): RequestLog {
  const log: RequestLog = { count: 0, bodies: [] };
  mockServer.use(
    http.post(apiUrl(path), async ({ request }) => {
      log.count += 1;
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      log.bodies.push(body as Record<string, unknown>);
    }),
  );
  return log;
}

function accountBy(provider: string): Account {
  const account = mockDb.accounts.find((item) => item.provider === provider);
  if (!account) throw new Error(`no ${provider} account in the mock data`);
  return account;
}

function Harness({
  account,
  initialMethod,
}: {
  account: Account;
  initialMethod?: AddAccountMethod;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AddAccountDialog
      initialMethod={initialMethod}
      onOpenChange={setOpen}
      open={open}
      relogin={account}
    />
  );
}

async function expectClosed(): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector('[data-slot="dialog-popup"]')).not.toBeInTheDocument(),
  );
}

async function expectToast(text: string | RegExp): Promise<void> {
  expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
}

/** Pastes `json` into the credentials field and submits it. */
async function submitCredentials(user: UserEvent, json: string): Promise<void> {
  const field = await screen.findByRole("textbox", { name: "Credentials JSON" });
  await user.click(field);
  await user.paste(json);
  await user.click(screen.getByRole("button", { name: "Sign in again" }));
}

const OTHER_USER = JSON.stringify({
  refreshToken: "other-user-refresh",
  clientId: "client",
  clientSecret: "secret",
});

describe("AddAccountDialog in re-login mode", () => {
  it("names the account and opens the method it signed in with", async () => {
    const account = { ...accountBy("BuilderId"), region: "eu-central-1" };
    renderWithProviders(<Harness account={account} />, { privacy: false });

    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    expect(
      within(dialog).getByText(`Sign in again as ${account.email}.`, { exact: false }),
    ).toBeInTheDocument();
    const rail = within(dialog).getByRole("navigation", { name: "Method" });
    expect(within(rail).getByRole("button", { name: "AWS Builder ID" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Region" })).toHaveValue("eu-central-1");
  });

  it("opens a GitHub account on the web cookie flow with GitHub chosen", async () => {
    renderWithProviders(<Harness account={accountBy("Github")} />);
    expect(await screen.findByRole("heading", { name: "Kiro web cookie" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("GitHub");
  });

  it("keeps an API key account's region for a key without |region", async () => {
    const imports = logRequests("/auth/credentials");
    const account = { ...accountBy("APIKey"), region: "eu-central-1" };
    const { user } = renderWithProviders(<Harness account={account} />);
    expect(await screen.findByRole("heading", { name: "Kiro API key" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Region" })).toHaveValue("eu-central-1");

    // One key, so the field says so: no "Kiro API keys" or "One per line".
    expect(screen.queryByRole("textbox", { name: "Kiro API keys" })).not.toBeInTheDocument();
    expect(screen.queryByText(/One per line/)).not.toBeInTheDocument();
    expect(screen.getByText("Sign in again with Kiro API key.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Kiro API key" }), "ksk_fresh");
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(imports.count).toBe(1));
    expect(imports.bodies[0]).toMatchObject({
      kiroApiKey: "ksk_fresh",
      region: "eu-central-1",
      reloginAccountId: account.id,
    });
  });

  it("takes exactly one credential", async () => {
    const imports = logRequests("/auth/credentials");
    const { user } = renderWithProviders(
      <Harness account={accountBy("Enterprise")} initialMethod="credentials" />,
    );
    await submitCredentials(
      user,
      JSON.stringify([
        { refreshToken: "a", clientId: "c", clientSecret: "s" },
        { refreshToken: "b", clientId: "c", clientSecret: "s" },
      ]),
    );
    expect(
      await screen.findByText("Signing in again takes one credential. Paste only one."),
    ).toBeInTheDocument();
    expect(imports.count).toBe(0);
  });

  it("takes exactly one SSO token", async () => {
    const imports = logRequests("/auth/sso-token");
    const { user } = renderWithProviders(
      <Harness account={accountBy("Enterprise")} initialMethod="sso" />,
    );
    const field = await screen.findByRole("textbox", { name: "SSO tokens" });
    await user.click(field);
    await user.paste("first-token\nsecond-token");
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(
      await screen.findByText("Signing in again takes one credential. Paste only one."),
    ).toBeInTheDocument();
    expect(imports.count).toBe(0);
  });

  it("replaces the login in place without adding an account", async () => {
    const imports = logRequests("/auth/credentials");
    const refreshes = logRequests("/accounts/:id/refresh");
    const account = accountBy("Enterprise");
    const before = mockDb.accounts.length;
    const { user } = renderWithProviders(<Harness account={account} initialMethod="credentials" />);
    await submitCredentials(
      user,
      JSON.stringify({ refreshToken: "fresh", clientId: "c", clientSecret: "s" }),
    );

    await expectClosed();
    expect(imports.bodies[0]).toMatchObject({ reloginAccountId: account.id });
    expect(mockDb.accounts).toHaveLength(before);
    await expectToast(/ is signed in again\.$/);
    // The server checks the new login itself; the dialog does not refresh it.
    expect(refreshes.count).toBe(0);
  });

  it("asks before replacing the identity, then applies the waiting login", async () => {
    const confirms = logRequests("/accounts/:id/relogin/confirm");
    const account = accountBy("Enterprise");
    const { user } = renderWithProviders(
      <Harness account={account} initialMethod="credentials" />,
      { privacy: false },
    );
    await submitCredentials(user, OTHER_USER);

    const ask = await screen.findByRole("alertdialog", {
      name: "Switch this account to another user?",
    });
    expect(within(ask).getByText(/someone\.else@northwind-labs\.dev/)).toBeInTheDocument();
    expect(within(ask).getByText(new RegExp(account.email.replace(/\./g, "\\.")))).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Switch user" }));

    await expectClosed();
    expect(confirms.count).toBe(1);
    expect(confirms.bodies[0]).toHaveProperty("pendingId");
    expect(mockDb.accounts.find((item) => item.id === account.id)?.email).toBe(
      "someone.else@northwind-labs.dev",
    );
    await expectToast("someone.else@northwind-labs.dev is signed in again.");
  });

  it("names the stored account a sign-in belongs to, masked, and asks nothing", async () => {
    mockServer.use(
      http.post(apiUrl("/auth/credentials"), () =>
        HttpResponse.json(
          {
            success: false,
            error: "the new sign-in belongs to another account in the pool",
            code: "relogin_other_account",
            accountId: "x",
            otherAccountId: "other-id",
            otherEmail: "teammate@northwind-labs.dev",
            saved: true,
          },
          { status: 409 },
        ),
      ),
    );
    const account = accountBy("Enterprise");
    const { user } = renderWithProviders(
      <Harness account={account} initialMethod="credentials" />,
      { privacy: true },
    );
    await submitCredentials(user, OTHER_USER);

    await expectToast(/^This sign-in belongs to te\S+@\S+, another account in the pool\./);
    expect(screen.queryByText(/teammate@northwind-labs\.dev/)).not.toBeInTheDocument();
    await expectToast(/now uses the new sign-in\.$/);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockDb.accounts.find((item) => item.id === account.id)?.email).toBe(account.email);
  });

  it("discards the waiting login when the admin declines", async () => {
    const discards = logRequests("/accounts/:id/relogin/discard");
    const confirms = logRequests("/accounts/:id/relogin/confirm");
    const account = accountBy("Enterprise");
    const { user } = renderWithProviders(<Harness account={account} initialMethod="credentials" />);
    await submitCredentials(user, OTHER_USER);

    const ask = await screen.findByRole("alertdialog", {
      name: "Switch this account to another user?",
    });
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(discards.count).toBe(1));
    expect(confirms.count).toBe(0);
    await expectToast("Nothing changed. The new sign-in was discarded.");
    expect(mockDb.accounts.find((item) => item.id === account.id)?.email).toBe(account.email);
    // The re-login dialog stays open for another try.
    expect(screen.getByRole("dialog", { name: "Sign in again" })).toBeInTheDocument();
  });
});

describe("Builder ID re-login", () => {
  let user: UserEvent;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  async function untilPolls(log: RequestLog, count: number): Promise<void> {
    for (let step = 0; step < 100 && log.count < count; step++) {
      await act(() => vi.advanceTimersByTimeAsync(200));
    }
    expect(log.count).toBeGreaterThanOrEqual(count);
  }

  it("sends the account id at start and saves the login into it", async () => {
    const starts = logRequests("/auth/builderid/start");
    const polls = logRequests("/auth/builderid/poll");
    const account = accountBy("BuilderId");
    const before = mockDb.accounts.length;
    renderWithProviders(<Harness account={account} />, { privacy: false });

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(starts.bodies[0]).toMatchObject({ reloginAccountId: account.id });

    await untilPolls(polls, 3);
    await expectClosed();
    expect(mockDb.accounts).toHaveLength(before);
    await expectToast(`${account.email} is signed in again.`);
  });

  it("stops at the start when the account is gone", async () => {
    const polls = logRequests("/auth/builderid/poll");
    const account = { ...accountBy("BuilderId"), id: "gone-account" };
    renderWithProviders(<Harness account={account} />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await expectToast("Could not start sign-in: Account not found.");
    expect(screen.queryByText("ABCD-EFGH")).not.toBeInTheDocument();
    expect(polls.count).toBe(0);
  });
});
