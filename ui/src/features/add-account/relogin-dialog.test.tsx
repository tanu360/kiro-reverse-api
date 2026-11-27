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

/** The credentials re-login dialog with a Reopen button outside it. */
function Reopenable({ account }: { account: Account }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Reopen
      </button>
      <AddAccountDialog
        initialMethod="credentials"
        onOpenChange={setOpen}
        open={open}
        relogin={account}
      />
    </>
  );
}

async function expectClosed(): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector('[data-slot="dialog-popup"]')).not.toBeInTheDocument(),
  );
}

/** Read out by the app's live region. */
async function expectAnnounced(text: string | RegExp): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
}

/** The flow's one-line error at the end of the open dialog. */
async function expectFlowError(text: string | RegExp): Promise<void> {
  const line = await screen.findByText(text, { selector: '[data-slot="alert-description"]' });
  expect(line.closest('[data-slot="action-error"]')).toHaveAttribute("role", "alert");
  expect(line.closest('[data-slot="dialog-popup"]')).not.toBeNull();
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
    expect(await screen.findByRole("heading", { name: "Kiro Web Cookie" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("GitHub");
  });

  it("keeps an API key account's region for a key without |region", async () => {
    const imports = logRequests("/auth/credentials");
    const account = { ...accountBy("APIKey"), region: "eu-central-1" };
    const { user } = renderWithProviders(<Harness account={account} />);
    expect(await screen.findByRole("heading", { name: "Kiro API Key" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Region" })).toHaveTextContent("eu-central-1");

    // One key, so the field says so: no "Kiro API keys" or "One per line".
    expect(screen.queryByRole("textbox", { name: "Kiro API keys" })).not.toBeInTheDocument();
    expect(screen.queryByText(/One per line/)).not.toBeInTheDocument();
    expect(screen.getByText("Sign in again with Kiro API Key.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Kiro API Key" }), "ksk_fresh");
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(imports.count).toBe(1));
    expect(imports.bodies[0]).toMatchObject({
      kiroApiKey: "ksk_fresh",
      region: "eu-central-1",
      reloginAccountId: account.id,
    });
  });

  it("asks for a served region when an API key account's own is one Kiro does not serve", async () => {
    const imports = logRequests("/auth/credentials");
    const account = { ...accountBy("APIKey"), region: "us-west-2" };
    const { user } = renderWithProviders(<Harness account={account} />);
    const region = await screen.findByRole("combobox", { name: "Region" });
    await user.type(screen.getByRole("textbox", { name: "Kiro API Key" }), "ksk_fresh");
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(
      await screen.findByText(
        "Kiro API keys work in us-east-1 and eu-central-1 only, not us-west-2.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(region).toHaveFocus());
    expect(imports.count).toBe(0);

    // A key that names a served region of its own does not use the field.
    await user.type(screen.getByRole("textbox", { name: "Kiro API Key" }), "|eu-central-1");
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(imports.count).toBe(1));
    expect(imports.bodies[0]).toMatchObject({ kiroApiKey: "ksk_fresh|eu-central-1", region: "" });
  });

  it("opens the local cache flow on the provider the account signed in with", async () => {
    renderWithProviders(<Harness account={accountBy("Enterprise")} initialMethod="local" />);
    expect(await screen.findByRole("combobox", { name: "Provider" })).toHaveTextContent(
      "IAM Identity Center (Enterprise SSO)",
    );
  });

  it("says a switched-off account stays off after signing in again", async () => {
    const account = { ...accountBy("BuilderId"), enabled: false, banStatus: "DISABLED" as const };
    renderWithProviders(<Harness account={account} />);
    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    expect(
      within(dialog).getByText(/It stays switched off\. Switch it on afterwards/),
    ).toBeInTheDocument();
  });

  it("says nothing about the switch for a banned account, whose ban the sign-in lifts", async () => {
    const account = {
      ...accountBy("BuilderId"),
      enabled: false,
      banStatus: "BANNED" as const,
      banReason: "Authentication failed - token invalid or expired",
    };
    renderWithProviders(<Harness account={account} />);
    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    expect(within(dialog).queryByText(/stays switched off/)).not.toBeInTheDocument();
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
    await expectAnnounced(/ is signed in again\.$/);
    // The server checks the new login itself; the dialog does not refresh it.
    expect(refreshes.count).toBe(0);
  });

  it("stays open on the result when the server could not confirm the same user", async () => {
    const account = accountBy("Enterprise");
    mockServer.use(
      http.post(apiUrl("/auth/credentials"), () =>
        HttpResponse.json({
          success: true,
          relogin: true,
          identityVerified: false,
          identityReplaced: false,
          account: { id: account.id, email: account.email },
        }),
      ),
    );
    const { user } = renderWithProviders(
      <Harness account={account} initialMethod="credentials" />,
      { privacy: false },
    );
    await submitCredentials(
      user,
      JSON.stringify({ refreshToken: "fresh", clientId: "c", clientSecret: "s" }),
    );

    // One amber line in place of the flow, read out by its alert role; Close takes focus.
    const line = await screen.findByText(
      `${account.email} is signed in again. Could not confirm that this sign-in is the same user.`,
      { selector: '[data-slot="alert-description"]' },
    );
    expect(line.closest('[data-slot="alert"]')).toHaveAttribute("role", "alert");
    const footer = document.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    if (!footer) throw new Error("no dialog footer");
    const buttons = within(footer).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Close"]);
    await waitFor(() => expect(buttons[0]).toHaveFocus());
    await user.click(buttons[0]);
    await expectClosed();
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
    await expectAnnounced("someone.else@northwind-labs.dev is signed in again.");
  });

  it("drops a replace that answers after Cancel, leaving a reopened dialog open", async () => {
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let applies = 0;
    mockServer.use(
      http.post(apiUrl("/accounts/:id/relogin/confirm"), async () => {
        applies += 1;
        await answered;
      }),
    );
    const { user } = renderWithProviders(<Reopenable account={accountBy("Enterprise")} />);
    await submitCredentials(user, OTHER_USER);
    const ask = await screen.findByRole("alertdialog", {
      name: "Switch this account to another user?",
    });
    await user.click(within(ask).getByRole("button", { name: "Switch user" }));
    await waitFor(() => expect(applies).toBe(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    // Cancel still closes while the apply runs; the dialog opens again before it answers.
    const footer = document.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    if (!footer) throw new Error("no dialog footer");
    await user.click(within(footer).getByRole("button", { name: "Cancel" }));
    await expectClosed();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    answer();

    // The late answer does not close the new dialog.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(dialog).not.toHaveAttribute("data-closed");
    expect(dialog).toHaveAttribute("data-open");
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

    // One line in the dialog, which stays open for another try.
    await expectFlowError(
      /^This sign-in belongs to te\S+@\S+, another account in the pool\. This account was not changed\. te\S+@\S+ now uses the new sign-in\.$/,
    );
    expect(screen.queryByText(/teammate@northwind-labs\.dev/)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Sign in again" })).toBeInTheDocument();
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
    await expectAnnounced("Nothing changed. The new sign-in was discarded.");
    expect(document.querySelector('[data-slot="action-error"]')).not.toBeInTheDocument();
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
    await expectAnnounced(`${account.email} is signed in again.`);
  });

  it("keeps the first step busy while a mismatch is confirmed and applied", async () => {
    const starts = logRequests("/auth/builderid/start");
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    mockServer.use(
      http.post(apiUrl("/auth/builderid/poll"), () =>
        HttpResponse.json(
          {
            success: false,
            error: "the new sign-in belongs to a different user than this account",
            code: "relogin_identity_mismatch",
            pendingId: "pending-1",
            accountId: "x",
            currentEmail: "",
            incomingEmail: "someone.else@northwind-labs.dev",
            expiresIn: 600,
          },
          { status: 409 },
        ),
      ),
      http.post(apiUrl("/accounts/:id/relogin/confirm"), async () => {
        await answered;
        return HttpResponse.json({ error: "Re-login not found or expired" }, { status: 404 });
      }),
    );
    renderWithProviders(<Harness account={accountBy("BuilderId")} />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    for (let step = 0; step < 50 && !screen.queryByRole("alertdialog"); step++) {
      await act(() => vi.advanceTimersByTimeAsync(200));
    }
    const ask = await screen.findByRole("alertdialog", {
      name: "Switch this account to another user?",
    });
    await user.click(within(ask).getByRole("button", { name: "Switch user" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    // Back on the first step, but no second login can start while the apply runs.
    const submit = screen.getByRole("button", { name: "Start sign-in" });
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("textbox", { name: "Region" })).toBeDisabled();
    await user.click(submit);
    expect(starts.count).toBe(1);

    answer();
    await expectFlowError("Re-login not found or expired");
    expect(screen.getByRole("button", { name: "Start sign-in" })).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("textbox", { name: "Region" })).toBeEnabled();
  });

  it("stops at the start when the account is gone", async () => {
    const polls = logRequests("/auth/builderid/poll");
    const account = { ...accountBy("BuilderId"), id: "gone-account" };
    renderWithProviders(<Harness account={account} />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await expectFlowError("Account not found.");
    expect(screen.queryByText("ABCD-EFGH")).not.toBeInTheDocument();
    expect(polls.count).toBe(0);
  });
});
