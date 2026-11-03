import { act, screen, waitFor } from "@testing-library/react";
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

/** Toasts are dialogs too, so look for the dialog popup itself. */
async function expectClosed(): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector('[data-slot="dialog-popup"]')).not.toBeInTheDocument(),
  );
}

/** A toast's text can also sit in its live-region announcement. */
async function expectToast(text: string | RegExp): Promise<void> {
  expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
}

describe("AddAccountDialog", () => {
  it("lists the eight methods and opens one, then goes back", async () => {
    const { user } = renderWithProviders(<Harness />);
    const dialog = await screen.findByRole("dialog", { name: "Add account" });
    for (const title of [
      "AWS Builder ID",
      "IAM Identity Center (Enterprise SSO)",
      "Microsoft SSO",
      "SSO token",
      "Kiro local cache",
      "Credentials JSON",
      "Kiro web cookie",
      "Kiro API key",
    ]) {
      expect(dialog).toHaveTextContent(title);
    }
    await user.click(screen.getByRole("button", { name: /Kiro API key/ }));
    expect(await screen.findByRole("dialog", { name: "Kiro API key" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByRole("dialog", { name: "Add account" })).toBeInTheDocument();
  });

  it("opens straight into initialMethod", async () => {
    renderWithProviders(<Harness initialMethod="cookie" />);
    expect(await screen.findByRole("dialog", { name: "Kiro web cookie" })).toBeInTheDocument();
  });
});

describe("Builder ID", () => {
  let user: UserEvent;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
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

    await untilPolls(polls, 3);
    await expectClosed();
    const id = lastAccountId();
    expect(onAdded).toHaveBeenCalledWith([id]);
    expect(polls.count).toBe(3);
    await waitFor(() => expect(refreshed).toEqual([id]));
    await expectToast(/^Account added: /);
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

    await expectToast("Could not add the account: authorization expired");
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
});

describe("Microsoft SSO", () => {
  it("walks both legs and the profile choice", async () => {
    const refreshed = mockRefresh();
    const selects = logRequests("/auth/microsoft-sso/select-profile");
    const onAdded = vi.fn();
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" onAdded={onAdded} />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    expect(await screen.findByText("Step 1: sign in to the Kiro portal")).toBeInTheDocument();

    const callback = screen.getByRole("textbox", { name: "Callback URL" });
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    expect(await screen.findByText("Paste the callback URL first.")).toBeInTheDocument();

    await user.type(callback, "http://localhost:3128/signin/callback?login_option=external_idp");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    expect(await screen.findByText("Step 2: sign in with Microsoft")).toBeInTheDocument();
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

  it("shows the warning when the profile is not resolved yet", async () => {
    mockRefresh();
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" />);
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await user.type(await screen.findByRole("textbox", { name: "Callback URL" }), "http://x/leg1");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await screen.findByText("Step 2: sign in with Microsoft");
    await user.type(screen.getByRole("textbox", { name: "Callback URL" }), "http://x/?noprofile");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await expectClosed();
    await expectToast(/^Account added: /);
    await expectToast(/Kiro profile could not be resolved yet/);
  });

  it("cancels the server session when the dialog closes mid-flow", async () => {
    const cancels = logRequests("/auth/microsoft-sso/cancel");
    const { user } = renderWithProviders(<Harness initialMethod="microsoft" />);

    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await screen.findByText("Step 1: sign in to the Kiro portal");
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
    await screen.findByText("Step 1: sign in to the Kiro portal");
    const [sessionId] = Object.keys(mockDb.pending.microsoft);

    const late = deferred("/auth/microsoft-sso/complete", {
      success: true,
      stage: "profile",
      selectionId: "late-selection",
      profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/LATE", region: "us-east-1" }],
    });
    await user.type(screen.getByRole("textbox", { name: "Callback URL" }), "http://x/leg1");
    await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
    // While the request runs, the X is hidden and Escape is ignored; Cancel still closes.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument(),
    );
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
    expect(screen.queryByText(/Could not add the account/)).not.toBeInTheDocument();
  });

  it("cancels the server session on unmount", async () => {
    const cancels = logRequests("/auth/microsoft-sso/cancel");
    const { user, unmount } = renderWithProviders(<Harness initialMethod="microsoft" />);
    await user.click(await screen.findByRole("button", { name: "Start sign-in" }));
    await screen.findByText("Step 1: sign in to the Kiro portal");
    const [sessionId] = Object.keys(mockDb.pending.microsoft);
    unmount();
    await waitFor(() => expect(cancels.bodies).toEqual([{ sessionId, selectionId: "" }]));
  });
});

describe("IAM Identity Center", () => {
  it("stays on step 2 with an error toast when completion fails", async () => {
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

    await expectToast("Could not add the account: 无效的回调 URL");
    expect(
      screen.getByRole("dialog", { name: "IAM Identity Center (Enterprise SSO)" }),
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
});

describe("SSO token", () => {
  it("disables Add and blocks Escape while the import runs", async () => {
    mockRefresh();
    const onAdded = vi.fn();
    const pending = deferred("/auth/sso-token", {
      success: true,
      accounts: [{ id: "acc-sso-1", email: "" }],
      errors: null,
    });
    const { user } = renderWithProviders(<Harness initialMethod="sso" onAdded={onAdded} />);

    await user.type(await screen.findByRole("textbox", { name: "SSO tokens" }), "token-1");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const busy = await screen.findByRole("button", { name: "Importing…" });
    expect(busy).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "SSO token" })).toBeInTheDocument();

    pending.release();
    await expectClosed();
    expect(onAdded).toHaveBeenCalledWith(["acc-sso-1"]);
    await expectToast("Added 1 account.");
  });
});

describe("Kiro API key", () => {
  it("reports a partial import in one toast", async () => {
    const refreshed = mockRefresh();
    const imports = logRequests("/auth/credentials");
    const onAdded = vi.fn();
    const { user } = renderWithProviders(<Harness initialMethod="apikey" onAdded={onAdded} />);

    await user.type(
      await screen.findByRole("textbox", { name: "Kiro API keys" }),
      "ksk_duplicate{Enter}ksk_duplicate|eu-central-1",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    await expectToast("Added 1 account, 1 failed.");
    await expectToast("This Kiro API key is already added.");
    await expectClosed();
    const id = lastAccountId();
    expect(onAdded).toHaveBeenCalledWith([id]);
    expect(imports.bodies).toEqual([
      { kiroApiKey: "ksk_duplicate", authMethod: "api_key", region: "us-east-1" },
      { kiroApiKey: "ksk_duplicate|eu-central-1", authMethod: "api_key", region: "" },
    ]);
    await waitFor(() => expect(refreshed).toEqual([id]));
  });

  it("asks for a key when the list is empty", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="apikey" />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByText("Enter at least one Kiro API key.")).toBeInTheDocument();
  });
});

describe("Credentials JSON", () => {
  it("shows the parse error inline", async () => {
    const { user } = renderWithProviders(<Harness initialMethod="credentials" />);
    await user.type(await screen.findByRole("textbox", { name: "Credentials JSON" }), "nope");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("The text is not valid JSON.")).toBeInTheDocument();
  });
});
