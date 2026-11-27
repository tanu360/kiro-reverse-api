import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      // No response: MSW falls through to the add-account mock handler.
    }),
  );
  return log;
}

/** POST /accounts/:id/refresh belongs to the accounts feature mocks; this test brings its own. */
function mockRefresh(): string[] {
  const refreshed: string[] = [];
  mockServer.use(
    http.post(apiUrl("/accounts/:id/refresh"), ({ params }) => {
      refreshed.push(String(params.id));
      return HttpResponse.json({ success: true });
    }),
  );
  return refreshed;
}

/** A handler that answers only when the test releases it. */
function deferred(
  path: string,
  body: Parameters<typeof HttpResponse.json>[0],
): { release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockServer.use(
    http.post(apiUrl(path), async () => {
      await gate;
      return HttpResponse.json(body);
    }),
  );
  return { release };
}

function Harness({
  initialMethod,
  onAdded,
}: {
  initialMethod?: AddAccountMethod;
  onAdded?: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AddAccountDialog
      initialMethod={initialMethod}
      onAdded={onAdded}
      onOpenChange={setOpen}
      open={open}
    />
  );
}

function lastAccountId(): string {
  return mockDb.accounts[mockDb.accounts.length - 1].id;
}

/** Looks for the dialog popup itself, not any element with a dialog role. */
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

/** The buttons in the dialog's footer, in order. */
function footerButtons(): HTMLElement[] {
  const footer = document.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
  if (!footer) throw new Error("no dialog footer");
  return within(footer).getAllByRole("button");
}

/**
 * A login that went in with a warning: one amber line in the open dialog, and Close as the
 * footer's only button, with focus.
 */
async function expectSavedWarning(text: string | RegExp): Promise<HTMLElement> {
  const line = await screen.findByText(text, { selector: '[data-slot="alert-description"]' });
  expect(line.closest('[data-slot="alert"]')).toHaveAttribute("role", "alert");
  expect(line.closest('[data-slot="dialog-popup"]')).not.toBeNull();
  const buttons = footerButtons();
  expect(buttons.map((button) => button.textContent)).toEqual(["Close"]);
  await waitFor(() => expect(buttons[0]).toHaveFocus());
  return buttons[0];
}

/** Waits until the checklist step with this title is the current one. */
async function expectCurrentStep(title: string): Promise<void> {
  await waitFor(() =>
    expect(screen.getByText(title).closest("li")).toHaveAttribute("aria-current", "step"),
  );
}

describe("AddAccountDialog", () => {
  it("lists the eight methods in the rail, opens Builder ID, and switches with one click", async () => {
    const { user } = renderWithProviders(<Harness />);
    const dialog = await screen.findByRole("dialog", { name: "Add account" });
    const rail = within(dialog).getByRole("navigation", { name: "Method" });
    for (const name of [
      "AWS Builder ID",
      "IAM Identity Center",
      "Microsoft SSO",
      "Kiro Local Cache",
      "Credentials JSON",
      "SSO Token",
      "Kiro Web Cookie",
      "Kiro API Key",
    ]) {
      expect(within(rail).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(rail).getByRole("button", { name: "AWS Builder ID" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("heading", { name: "AWS Builder ID" })).toBeInTheDocument();

    await user.click(within(rail).getByRole("button", { name: "Kiro API Key" }));
    expect(await screen.findByRole("heading", { name: "Kiro API Key" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Kiro API Key" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // The dialog keeps its name; only the pane changes.
    expect(screen.getByRole("dialog", { name: "Add account" })).toBeInTheDocument();
  });

  it("opens straight into initialMethod", async () => {
    renderWithProviders(<Harness initialMethod="cookie" />);
    expect(await screen.findByRole("heading", { name: "Kiro Web Cookie" })).toBeInTheDocument();
  });
});

describe("Builder ID", () => {
  let user: UserEvent;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
    // Fire the frames still queued on the fake clock first: Motion (the animated icons) waits
    // for one, and would stall every later animation in this file without it.
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /**
   * Advances fake time in small steps until the poll log reaches `count`. (waitFor cannot drive
   * this: advancing the clock inside it would also fire its own timeout.)
   */
  async function untilPolls(log: RequestLog, count: number): Promise<void> {
    for (let step = 0; step < 100 && log.count < count; step++) {
      await act(() => vi.advanceTimersByTimeAsync(200));
    }
    expect(log.count).toBeGreaterThanOrEqual(count);
  }

  it("shows the code, polls until completed, closes and refreshes the new account", async () => {
    const polls = logRequests("/auth/builderid/poll");
    const refreshed = mockRefresh();
    const onAdded = vi.fn();
    renderWithProviders(<Harness initialMethod="builderid" onAdded={onAdded} />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByText("Waiting for authorization…")).toBeInTheDocument();
    expect(polls.count).toBe(0);
    // The Verification URL row has its open icon before the copy icon; the footer keeps its
    // labelled Open AWS page button.
    const verifyUrl = "https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH";
    const open = screen.getByRole("link", { name: "Open link" });
    expect(open).toHaveAttribute("href", verifyUrl);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open.nextElementSibling).toBe(screen.getByRole("button", { name: "Copy link" }));
    expect(screen.getByRole("link", { name: "Open AWS page" })).toHaveAttribute("href", verifyUrl);

    await untilPolls(polls, 3);
    await expectClosed();
    const id = lastAccountId();
    expect(onAdded).toHaveBeenCalledWith([id]);
    expect(polls.count).toBe(3);
    await waitFor(() => expect(refreshed).toEqual([id]));
    await expectAnnounced(/^Added the account /);
  });

  it("stops polling when the dialog closes", async () => {
    const polls = logRequests("/auth/builderid/poll");
    renderWithProviders(<Harness initialMethod="builderid" />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await screen.findByText("ABCD-EFGH");
    await untilPolls(polls, 1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expectClosed();

    const seen = polls.count;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(polls.count).toBe(seen);
    expect(Object.keys(mockDb.pending.builderId)).toHaveLength(1);
  });

  it("stops and reports an expired authorization", async () => {
    const polls = logRequests("/auth/builderid/poll");
    renderWithProviders(<Harness initialMethod="builderid" />);

    const region = await screen.findByRole("textbox", { name: "Region" });
    await user.clear(region);
    await user.type(region, "eu-west-9");
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    await screen.findByText("ABCD-EFGH");
    await untilPolls(polls, 1);

    // Back on the first step, which says why.
    await expectFlowError("authorization expired");
    expect(await screen.findByRole("button", { name: "Start sign-in" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(polls.count).toBe(1);
  });

  it("rejects a malformed region before calling the server", async () => {
    const starts = logRequests("/auth/builderid/start");
    renderWithProviders(<Harness initialMethod="builderid" />);

    const region = await screen.findByRole("textbox", { name: "Region" });
    await user.clear(region);
    await user.type(region, "useast1");
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    expect(await screen.findByText("Enter a region like us-east-1.")).toBeInTheDocument();
    expect(starts.count).toBe(0);
  });

  it("drops the last failure when the next try stops at the region", async () => {
    mockServer.use(
      http.post(apiUrl("/auth/builderid/start"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderWithProviders(<Harness initialMethod="builderid" />);
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await expectFlowError("boom");

    const region = screen.getByRole("textbox", { name: "Region" });
    await user.clear(region);
    await user.type(region, "useast1");
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    expect(await screen.findByText("Enter a region like us-east-1.")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="action-error"]')).not.toBeInTheDocument();
  });
});

describe("Microsoft SSO", () => {
  it("walks both legs and the profile choice", async () => {
    const refreshed = mockRefresh();
    const selects = logRequests("/auth/microsoft-sso/select-profile");
    const onAdded = vi.fn();
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" onAdded={onAdded} />);

    expect(await screen.findByText(/After each sign-in, paste the address/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    // The idle guide repeats the step labels, so wait for the step's own field.
    const callback = await screen.findByRole("textbox", { name: "Callback URL" });
    await expectCurrentStep("Sign in to the Kiro portal");
    expect(screen.queryByText(/After each sign-in, paste the address/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    expect(await screen.findByText("Paste the callback URL first.")).toBeInTheDocument();
    // The paste instructions are a step note, so the error does not replace them.
    expect(screen.getByText(/fails to load\. That is expected/)).toBeInTheDocument();

    await user.type(callback, "http://localhost:3128/signin/callback?login_option=external_idp");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await expectCurrentStep("Sign in with Microsoft");
    const second = screen.getByRole("textbox", { name: "Callback URL" });
    expect(second).toHaveValue("");

    await user.type(second, "  http://localhost:3128/oauth/callback?code=c&state=s&profiles=2 ");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(screen.getByText("Northwind Engineering")).toBeInTheDocument();

    await user.click(radios[1]);
    await user.click(screen.getByRole("button", { name: "Use profile" }));
    await expectClosed();
    const id = lastAccountId();
    expect(onAdded).toHaveBeenCalledWith([id]);
    expect(selects.bodies[0]).toMatchObject({
      profileArn: "arn:aws:codewhisperer:us-east-1:381492027763:profile/HV4N8TQW2JDE",
    });
    expect(mockDb.accounts.at(-1)?.profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:381492027763:profile/HV4N8TQW2JDE",
    );
    await waitFor(() => expect(refreshed).toEqual([id]));
  });

  it("stays open on the warning when the profile is not resolved yet", async () => {
    const refreshed = mockRefresh();
    const onAdded = vi.fn();
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" onAdded={onAdded} />);
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await user.type(await screen.findByRole("textbox", { name: "Callback URL" }), "http://x/leg1");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await expectCurrentStep("Sign in with Microsoft");
    await user.type(screen.getByRole("textbox", { name: "Callback URL" }), "http://x/?noprofile");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));

    // One amber line after the result, translated from warningCode with the upstream reason as
    // the detail, in place of the finished flow.
    const close = await expectSavedWarning(
      /^Added the account \S+ The account was added, but its Kiro profile could not be found yet\. It is looked up again on the next request\. \(Details: no available Kiro profile\)$/,
    );
    expect(screen.queryByRole("textbox", { name: "Callback URL" })).not.toBeInTheDocument();
    const id = lastAccountId();
    expect(onAdded).toHaveBeenCalledWith([id]);
    await waitFor(() => expect(refreshed).toEqual([id]));

    await user.click(close);
    await expectClosed();
  });

  it("cancels the server session when the dialog closes mid-flow", async () => {
    const cancels = logRequests("/auth/microsoft-sso/cancel");
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await screen.findByRole("textbox", { name: "Callback URL" });
    const [sessionId] = Object.keys(mockDb.pending.microsoft);
    expect(sessionId).toBeTruthy();

    await user.keyboard("{Escape}");
    await expectClosed();
    await waitFor(() => expect(cancels.bodies).toEqual([{ sessionId, selectionId: "" }]));
    expect(mockDb.pending.microsoft).toEqual({});
  });

  it("ignores a late response and cancels the session it carries", async () => {
    const cancels = logRequests("/auth/microsoft-sso/cancel");
    const onAdded = vi.fn();
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" onAdded={onAdded} />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await screen.findByRole("textbox", { name: "Callback URL" });
    const [sessionId] = Object.keys(mockDb.pending.microsoft);

    const late = deferred("/auth/microsoft-sso/complete", {
      success: true,
      stage: "profile",
      selectionId: "late-selection",
      profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/LATE", region: "us-east-1" }],
    });
    await user.type(screen.getByRole("textbox", { name: "Callback URL" }), "http://x/leg1");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    // While the request runs, the X is disabled and Escape is ignored; Cancel still closes.
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expectClosed();
    await waitFor(() => expect(cancels.bodies).toEqual([{ sessionId, selectionId: "" }]));

    late.release();
    await waitFor(() =>
      expect(cancels.bodies).toEqual([
        { sessionId, selectionId: "" },
        { sessionId: "", selectionId: "late-selection" },
      ]),
    );
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="action-error"]')).not.toBeInTheDocument();
  });

  it("cancels the server session on unmount", async () => {
    const cancels = logRequests("/auth/microsoft-sso/cancel");
    const { user, unmount } = renderWithProviders(<Harness initialMethod="microsoft" />);
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await screen.findByRole("textbox", { name: "Callback URL" });
    const [sessionId] = Object.keys(mockDb.pending.microsoft);
    unmount();
    await waitFor(() => expect(cancels.bodies).toEqual([{ sessionId, selectionId: "" }]));
  });
});

describe("IAM Identity Center", () => {
  it("stays on step 2 with the error above its buttons when completion fails", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="iam" />);

    await user.type(
      await screen.findByRole("textbox", { name: "Start URL" }),
      "https://acme.awsapps.com/start",
    );
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    expect(await screen.findByText("Sign-in URL")).toBeInTheDocument();

    const callback = screen.getByRole("textbox", { name: "Callback URL" });
    await user.type(callback, "http://127.0.0.1/oauth/callback?error=denied");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));

    await expectFlowError("The callback URL is not valid. Copy the full address again.");
    expect(
      screen.getByRole("heading", { name: "IAM Identity Center (Enterprise SSO)" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Callback URL" })).toHaveValue(
      "http://127.0.0.1/oauth/callback?error=denied",
    );
    expect(screen.getByRole("button", { name: "Complete sign-in" })).toBeEnabled();
  });

  it("completes with a trimmed callback URL", async () => {
    mockRefresh();
    const completes = logRequests("/auth/iam-sso/complete");
    const onAdded = vi.fn();
    const { user } = renderWithProviders(<Harness initialMethod="iam" onAdded={onAdded} />);
    await user.type(
      await screen.findByRole("textbox", { name: "Start URL" }),
      "https://acme.awsapps.com/start",
    );
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Callback URL" }),
      "  http://127.0.0.1/oauth/callback?code=c&state=s  ",
    );
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await expectClosed();
    expect(completes.bodies[0]).toMatchObject({
      callbackUrl: "http://127.0.0.1/oauth/callback?code=c&state=s",
    });
    expect(onAdded).toHaveBeenCalledWith([lastAccountId()]);
  });

  it("says the login updated the stored account when the server matched one", async () => {
    mockRefresh();
    const stored = mockDb.accounts[0];
    mockServer.use(
      http.post(apiUrl("/auth/iam-sso/complete"), () =>
        HttpResponse.json({
          success: true,
          account: { id: stored.id, email: stored.email, updated: true },
        }),
      ),
    );
    const { user } = renderWithProviders(<Harness initialMethod="iam" />);
    await user.type(
      await screen.findByRole("textbox", { name: "Start URL" }),
      "https://acme.awsapps.com/start",
    );
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Callback URL" }),
      "http://127.0.0.1/oauth/callback?code=c&state=s",
    );
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await expectClosed();
    await expectAnnounced(/^Updated the existing account /);
  });
});

describe("SSO Token", () => {
  it("keeps the busy Add button focusable, ignores it and blocks Escape while the import runs", async () => {
    mockRefresh();
    const onAdded = vi.fn();
    const pending = deferred("/auth/sso-token", {
      success: true,
      accounts: [{ id: "acc-sso-1", email: "" }],
      errors: null,
    });
    // Registered last, so it sees each request before the deferred handler answers it.
    const imports = logRequests("/auth/sso-token");
    const { user } = renderWithProviders(<Harness initialMethod="sso" onAdded={onAdded} />);

    await user.type(await screen.findByRole("textbox", { name: "SSO tokens" }), "token-1");
    const busy = screen.getByRole("button", { name: "Add" });
    await user.click(busy);
    // The label stays while busy (a Spinner joins it), so Cancel beside it does not jump.
    await waitFor(() => expect(busy).toHaveAttribute("aria-busy", "true"));
    expect(busy).toHaveAccessibleName("Add");
    // aria-disabled, not disabled: focus stays on it instead of falling to <body>.
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toBeEnabled();
    await waitFor(() => expect(busy).toHaveFocus());
    await user.click(busy);
    await user.keyboard("{Enter}");
    expect(imports.count).toBe(1);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "SSO Token" })).toBeInTheDocument();

    pending.release();
    await expectClosed();
    expect(onAdded).toHaveBeenCalledWith(["acc-sso-1"]);
    await expectAnnounced("Added 1 account.");
  });
});

describe("Kiro API Key", () => {
  it("reports a partial import in one line and stays open on the key that failed", async () => {
    const refreshed = mockRefresh();
    const imports = logRequests("/auth/credentials");
    const onAdded = vi.fn();
    const { user } = renderWithProviders(<Harness initialMethod="apikey" onAdded={onAdded} />);

    const keys = await screen.findByRole("textbox", { name: "Kiro API keys" });
    await user.type(keys, "ksk_duplicate{Enter}ksk_duplicate|eu-central-1");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await expectFlowError("Added 1 account, 1 failed. This Kiro API key is already added.");
    // The added key is listed at once and leaves the field; the one that failed stays.
    const id = lastAccountId();
    expect(onAdded).toHaveBeenCalledWith([id]);
    expect(keys).toHaveValue("ksk_duplicate|eu-central-1");
    await waitFor(() => expect(keys).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Add account" })).toBeInTheDocument();
    // An account went in, so the footer's Cancel, which would undo nothing, reads Close.
    expect(footerButtons().map((button) => button.textContent)).toEqual(["Close", "Add"]);
    expect(imports.bodies).toEqual([
      { kiroApiKey: "ksk_duplicate", authMethod: "api_key", region: "us-east-1" },
      { kiroApiKey: "ksk_duplicate|eu-central-1", authMethod: "api_key", region: "" },
    ]);
    await waitFor(() => expect(refreshed).toEqual([id]));
  });

  it("shows only the reason when every key fails, and clears it on the next try", async () => {
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/auth/credentials"), () =>
        fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined,
      ),
    );
    mockRefresh();
    const { user } = renderWithProviders(<Harness initialMethod="apikey" />);
    const keys = await screen.findByRole("textbox", { name: "Kiro API keys" });
    await user.type(keys, "ksk_one");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await expectFlowError("boom");
    expect(keys).toHaveValue("ksk_one");
    expect(footerButtons().map((button) => button.textContent)).toEqual(["Cancel", "Add"]);

    fail = false;
    await user.click(screen.getByRole("button", { name: "Add" }));
    await expectClosed();
    await expectAnnounced("Added 1 account.");
  });

  it("asks for a key when the list is empty", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="apikey" />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByText("Enter at least one Kiro API key.")).toBeInTheDocument();
  });

  it("offers only the regions Kiro serves API keys from, and sends the one chosen", async () => {
    const imports = logRequests("/auth/credentials");
    mockRefresh();
    const { user } = renderWithProviders(<Harness initialMethod="apikey" />);
    const region = await screen.findByRole("combobox", { name: "Region" });
    expect(region).toHaveTextContent("us-east-1");
    await user.click(region);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["us-east-1", "eu-central-1"]);
    await user.click(screen.getByRole("option", { name: "eu-central-1" }));
    await user.type(screen.getByRole("textbox", { name: "Kiro API keys" }), "ksk_plain");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await expectClosed();
    expect(imports.bodies).toEqual([
      { kiroApiKey: "ksk_plain", authMethod: "api_key", region: "eu-central-1" },
    ]);
  });

  it("stops at a key whose |region Kiro does not serve, before calling the server", async () => {
    const imports = logRequests("/auth/credentials");
    const { user } = renderWithProviders(<Harness initialMethod="apikey" />);
    await screen.findByRole("combobox", { name: "Region" });
    const keys = screen.getByRole("textbox", { name: "Kiro API keys" });
    await user.type(keys, "ksk_good|eu-central-1{Enter}ksk_bad|US-West-2");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(
      await screen.findByText(
        "Kiro API keys work in us-east-1 and eu-central-1 only, not us-west-2.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(keys).toHaveFocus());
    expect(keys).toHaveAttribute("aria-invalid", "true");
    expect(imports.count).toBe(0);
  });

  it("stops at a key with a bar and no region, which the server refuses", async () => {
    const imports = logRequests("/auth/credentials");
    const { user } = renderWithProviders(<Harness initialMethod="apikey" />);
    await screen.findByRole("combobox", { name: "Region" });
    const keys = screen.getByRole("textbox", { name: "Kiro API keys" });
    await user.type(keys, "ksk_abc|");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Enter a region like us-east-1.")).toBeInTheDocument();
    expect(keys).toHaveAttribute("aria-invalid", "true");
    expect(imports.count).toBe(0);
  });
});

describe("Credentials JSON", () => {
  it("shows the parse error inline", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="credentials" />);
    await user.type(await screen.findByRole("textbox", { name: "Credentials JSON" }), "nope");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("The text is not valid JSON.")).toBeInTheDocument();
  });

  it("asks for the JSON when the field is empty", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="credentials" />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByText("Paste the credentials JSON.")).toBeInTheDocument();
  });
});

describe("Focus after a failed submit or a step change", () => {
  it("keeps focus on the rail when switching methods, and locks the rail while a request runs", async () => {
    const { user } = renderWithProviders(<Harness />);
    const rail = await screen.findByRole("navigation", { name: "Method" });
    const iam = within(rail).getByRole("button", { name: "IAM Identity Center" });
    await user.click(iam);
    expect(await screen.findByRole("textbox", { name: "Start URL" })).toBeInTheDocument();
    expect(iam).toHaveFocus();

    await user.click(within(rail).getByRole("button", { name: "Microsoft SSO" }));
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await screen.findByRole("textbox", { name: "Callback URL" });
    deferred("/auth/microsoft-sso/complete", { success: true, stage: "complete" });
    await user.type(screen.getByRole("textbox", { name: "Callback URL" }), "http://x/leg1");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await waitFor(() =>
      expect(within(rail).getByRole("button", { name: "AWS Builder ID" })).toBeDisabled(),
    );
    expect(within(rail).getByRole("button", { name: "Microsoft SSO" })).toBeEnabled();
  });

  it("IAM: focuses the first invalid field, the new step and the field to fix", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="iam" />);
    const startUrl = await screen.findByRole("textbox", { name: "Start URL" });
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    await waitFor(() => expect(startUrl).toHaveFocus());
    expect(startUrl).toHaveAttribute("aria-invalid", "true");

    // jsdom skips implicit (Enter) submission for a form with two text fields and its submit
    // button outside, so these steps click the button; browsers submit on Enter.
    await user.type(startUrl, "https://acme.awsapps.com/start");
    await user.click(screen.getByRole("button", { name: "Start sign-in" }));
    const callback = await screen.findByRole("textbox", { name: "Callback URL" });
    await waitFor(() => expect(callback).toHaveFocus());

    await user.type(callback, "http://127.0.0.1/oauth/callback?error=denied");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await expectFlowError("The callback URL is not valid. Copy the full address again.");
    await waitFor(() => expect(callback).toHaveFocus());
    expect(callback).toBeEnabled();
  });

  it("on touch screens, a step change focuses the step, not its text field", async () => {
    // A focused text field opens the on-screen keyboard over the drawer.
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("pointer: coarse"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    try {
      const { user } = renderWithProviders(<Harness initialMethod="iam" />);
      const startUrl = await screen.findByRole("textbox", { name: "Start URL" });
      await user.type(startUrl, "https://acme.awsapps.com/start");
      await user.click(screen.getByRole("button", { name: "Start sign-in" }));
      const callback = await screen.findByRole("textbox", { name: "Callback URL" });
      await waitFor(() => expect(callback.closest("form")).toHaveFocus());

      // An error still focuses the field to fix.
      await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
      expect(await screen.findByText("Paste the callback URL first.")).toBeInTheDocument();
      await waitFor(() => expect(callback).toHaveFocus());
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("SSO token: returns focus to the tokens after the server rejects them", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="sso" />);
    const tokens = await screen.findByRole("textbox", { name: "SSO tokens" });
    await user.type(tokens, "bad");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await expectFlowError(/./);
    await waitFor(() => expect(tokens).toHaveFocus());
  });

  it("Builder ID: focuses the code, then the region when polling fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithProviders(<Harness initialMethod="builderid" />);
      const region = await screen.findByRole("textbox", { name: "Region" });
      await user.clear(region);
      await user.type(region, "eu-west-9{Enter}");
      const code = await screen.findByText("ABCD-EFGH", { selector: "kbd > span" });
      // The code card (the copy button sits beside the code inside it) takes focus.
      await waitFor(() => expect(code.closest("[tabindex='-1']")).toHaveFocus());

      // eu-west-9 makes the mock report an expired authorization on the first poll.
      await act(() => vi.advanceTimersByTimeAsync(6000));
      await expectFlowError("authorization expired");
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Region" })).toHaveFocus());
    } finally {
      vi.runOnlyPendingTimers(); // queued Motion frames, see the Builder ID block
      vi.useRealTimers();
    }
  });

  it("Microsoft: focuses each step's callback field, then the chosen profile", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" />);
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    const callback = await screen.findByRole("textbox", { name: "Callback URL" });
    await waitFor(() => expect(callback).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(await screen.findByText("Paste the callback URL first.")).toBeInTheDocument();
    await waitFor(() => expect(callback).toHaveFocus());

    await user.type(callback, "http://x/leg1{Enter}");
    await expectCurrentStep("Sign in with Microsoft");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Callback URL" })).toHaveFocus(),
    );

    await user.type(screen.getByRole("textbox", { name: "Callback URL" }), "http://x/?profiles=2");
    await user.keyboard("{Enter}");
    const radios = await screen.findAllByRole("radio");
    await waitFor(() => expect(radios[0]).toHaveFocus());
  });

  it("Microsoft: every profile card shows title, region, then ARN", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" />);
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await user.type(await screen.findByRole("textbox", { name: "Callback URL" }), "http://x/leg1");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await expectCurrentStep("Sign in with Microsoft");
    await user.type(screen.getByRole("textbox", { name: "Callback URL" }), "http://x/?profiles=2");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await screen.findAllByRole("radio");

    const cards = screen.getAllByRole("radio").map((radio) => radio.closest("label"));
    const lines = cards.map((card) =>
      Array.from(card?.querySelectorAll(":scope > span:last-of-type > span") ?? []).map(
        (el) => el.textContent,
      ),
    );
    expect(lines).toEqual([
      [
        "Northwind Engineering",
        "eu-central-1",
        "arn:aws:codewhisperer:eu-central-1:381492027763:profile/QK7M2XRZ9PLA",
      ],
      [
        "Unnamed profile",
        "us-east-1",
        "arn:aws:codewhisperer:us-east-1:381492027763:profile/HV4N8TQW2JDE",
      ],
    ]);
  });

  it("Kiro local cache: shows the error under the textarea it is about and focuses it", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="local" />);
    const token = await screen.findByRole("textbox", { name: /kiro-auth-token\.json/ });
    // Instructions are helper text; the placeholder is an example value.
    expect(token).toHaveAttribute("placeholder", '{"refreshToken": "…"}');
    expect(token).toHaveAccessibleDescription(
      expect.stringContaining("Paste the file contents or upload the file."),
    );

    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(token).toHaveFocus());
    expect(token).toHaveAttribute("aria-invalid", "true");
    expect(token).toHaveAccessibleDescription(
      expect.stringContaining("Paste the contents of kiro-auth-token.json."),
    );

    // A client-file problem goes under {hash}.json instead.
    await user.type(token, '{{"refreshToken": "r"}');
    await user.click(screen.getByRole("button", { name: "Add" }));
    const client = screen.getByRole("textbox", { name: /\{hash\}\.json/ });
    await waitFor(() => expect(client).toHaveFocus());
    expect(client).toHaveAttribute("aria-invalid", "true");
    expect(client).toHaveAccessibleDescription(
      expect.stringContaining("IdC sign-in needs the {hash}.json file."),
    );
    expect(token).not.toHaveAttribute("aria-invalid", "true");
  });

  it("Kiro local cache: says under its field when an uploaded file cannot be read", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="local" />);
    const token = await screen.findByRole("textbox", { name: /kiro-auth-token\.json/ });
    const file = new File(["{}"], "kiro-auth-token.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.reject(new Error("unreadable")) });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    await user.upload(input, file);

    await waitFor(() => expect(token).toHaveFocus());
    expect(token).toHaveAttribute("aria-invalid", "true");
    expect(token).toHaveAccessibleDescription(expect.stringContaining("Could not read the file."));
    // Pasting instead clears it.
    await user.type(token, "x");
    expect(token).not.toHaveAttribute("aria-invalid", "true");
  });

  it("Credentials, cookie and API key: focus the field with the error", async () => {
    const cases: Array<[AddAccountMethod, string]> = [
      ["credentials", "Credentials JSON"],
      ["cookie", "Refresh token"],
      ["apikey", "Kiro API keys"],
    ];
    for (const [method, label] of cases) {
      const { user, unmount } = renderWithProviders(<Harness initialMethod={method} />);
      const field = await screen.findByRole("textbox", { name: label });
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(field).toHaveFocus());
      expect(field).toHaveAttribute("aria-invalid", "true");
      unmount();
    }
  });
});
