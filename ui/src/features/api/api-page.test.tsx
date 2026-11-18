import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsPatch } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { ApiAccessCard } from "./api-access-card";
import { endOfLocalDay, expiryInDays } from "./api-key-form";
import { ApiPage } from "./api-page";
import { ClientSnippetsCard } from "./client-snippets";
import { EndpointsCard } from "./endpoints-card";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

const copyTextMock = vi.mocked(copyText);

interface LoggedRequest {
  method: string;
  path: string;
  body: unknown;
}

let requests: LoggedRequest[] = [];
let settingsPosts: SettingsPatch[] = [];

// GET/POST /settings belong to the settings feature, so this test serves them itself.
function useSettingsHandlers(): void {
  mockServer.use(
    http.get(apiUrl("/settings"), () => HttpResponse.json(mockDb.settings)),
    http.post(apiUrl("/settings"), async ({ request }) => {
      const patch = (await request.json()) as SettingsPatch;
      settingsPosts.push(patch);
      Object.assign(mockDb.settings, patch);
      return HttpResponse.json({ success: true });
    }),
  );
}

beforeEach(() => {
  requests = [];
  settingsPosts = [];
  copyTextMock.mockReset();
  copyTextMock.mockResolvedValue(true);
  useSettingsHandlers();
  mockServer.events.on("request:start", async ({ request }) => {
    const body = request.method === "GET" ? null : await request.clone().text();
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: body ? JSON.parse(body) : null,
    });
  });
});

afterEach(() => {
  mockServer.events.removeAllListeners();
});

function sent(method: string, path: string): LoggedRequest[] {
  return requests.filter((r) => r.method === method && r.path === `/admin/api${path}`);
}

// The keys render as a table and as cards (CSS shows one), so row queries go through the table.
function keysTable(): HTMLElement {
  return screen.getByRole("table", { name: "API keys" });
}

function row(name: string): HTMLElement {
  const cell = within(keysTable()).getByText(name);
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no row for ${name}`);
  return tr;
}

async function renderPage() {
  const result = renderWithProviders(<ApiPage />);
  await screen.findAllByText("team-a");
  return result;
}

type User = Awaited<ReturnType<typeof renderPage>>["user"];

/** A request that waits until `release()`, then falls through to the mock's own handler. */
function gate(): { wait: () => Promise<void>; release: () => void } {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => opened, release: () => release() };
}

/** The notice for a failed action (one plain line with the server's reason). */
async function actionError(): Promise<HTMLElement> {
  return waitFor(() => {
    const notice = document.querySelector<HTMLElement>('[data-slot="action-error"]');
    if (!notice) throw new Error("no failure notice");
    return notice;
  });
}

function noActionError(): void {
  expect(document.querySelector('[data-slot="action-error"]')).toBeNull();
}

/** Said to a screen reader through the app's live region. */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
}

/** A create row's All / Only selected switch (a radio group named by the row's title). */
function scopeRadio(dialog: HTMLElement, group: string, name: string): HTMLElement {
  return within(within(dialog).getByRole("radiogroup", { name: group })).getByRole("radio", {
    name,
  });
}

/** Next from the create wizard's first step to its last one (Access). */
async function toAccessStep(user: User, dialog: HTMLElement): Promise<void> {
  await user.click(within(dialog).getByRole("button", { name: "Next" }));
  expect(within(dialog).getByText("Step 2 of 2 · Access")).toBeInTheDocument();
}

describe("ApiPage", () => {
  it("lists the seeded keys with masked values and flags the limit-reached key", async () => {
    await renderPage();
    const table = keysTable();
    for (const apiKey of mockDb.apiKeys) {
      expect(within(table).getByText(apiKey.keyMasked)).toBeInTheDocument();
      // Keys up to 10 characters are their own mask (Go MaskApiKey).
      if (apiKey.key !== apiKey.keyMasked) {
        expect(screen.queryByText(apiKey.key, { exact: false })).not.toBeInTheDocument();
      }
    }
    expect(within(row("ci-runner")).getByText("Limit reached")).toBeInTheDocument();
    expect(within(row("team-a")).queryByText("Limit reached")).not.toBeInTheDocument();
    expect(within(table).getAllByText("Limit reached")).toHaveLength(1);
    expect(within(table).getByText("Unnamed key")).toBeInTheDocument();
    // The card's description is one line; the usage page link lives in the new key's panel.
    expect(screen.queryByText(/Key holders can check their own usage at/)).not.toBeInTheDocument();
  });

  it("points key holders at the public link while it is live", async () => {
    // The admin is on localhost; key holders can only open the public link.
    mockDb.tunnel.pinned = { enabled: true, state: "running", url: "https://kiro.tail1234.ts.net" };
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    await toAccessStep(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    const panel = await screen.findByTestId("created-key-panel");
    // The link copies once the public link's status is in.
    await waitFor(async () => {
      await user.click(within(panel).getByRole("button", { name: "Copy usage page link" }));
      expect(copyTextMock).toHaveBeenLastCalledWith("https://kiro.tail1234.ts.net/user");
    });
  });

  it("creates a key and shows the full key once, ready to copy", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    // Two steps; the first has no Back.
    expect(within(dialog).getByText("Step 1 of 2 · Basics")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    // Enter in a field moves on, and focus lands on the next step's first field. user-event
    // only presses a submit button inside the form, and Next sits in the footer, so the test
    // sends the browser's implicit submit itself.
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.type(name, "  laptop  ");
    const form = name.closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    expect(within(dialog).getByText("Step 2 of 2 · Access")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Routing mode" })).toHaveFocus();
    // Back keeps what was typed.
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("  laptop  ");
    expect(within(dialog).getByRole("button", { name: "Next" })).toHaveFocus();
    expect(sent("POST", "/api-keys")).toHaveLength(0);
    await toAccessStep(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));

    const panel = await screen.findByTestId("created-key-panel");
    const created = mockDb.apiKeys.at(-1);
    expect(created?.name).toBe("laptop");
    expect(created?.key).toMatch(/^sk-[0-9a-f]{64}$/);
    // One line: the key masked as the table masks it; the copy button copies all of it.
    const key = created?.key ?? "";
    expect(within(panel).getByText(`${key.slice(0, 6)}****${key.slice(-4)}`)).toBeInTheDocument();
    expect(within(panel).queryByText(key)).not.toBeInTheDocument();
    expect(sent("POST", "/api-keys")[0]?.body).toEqual({
      name: "laptop",
      enabled: true,
      tokenLimit: 0,
      creditLimit: 0,
      callLimit: 0,
      accountIds: [],
      accountTags: [],
      allowedModels: [],
      rpmLimit: 0,
      expiresAt: 0,
      routingMode: "inherit",
    });

    await user.click(within(panel).getByRole("button", { name: "Copy new API key" }));
    expect(copyTextMock).toHaveBeenCalledWith(created?.key);
    // The key also signs in to the usage page; its link copies from the panel.
    await user.click(within(panel).getByRole("button", { name: "Copy usage page link" }));
    expect(copyTextMock).toHaveBeenCalledWith(`${window.location.origin}/user`);

    await user.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("created-key-panel")).not.toBeInTheDocument();
    // Dismiss went with the panel; focus lands on Create, not the page.
    expect(screen.getByRole("button", { name: "Create API key" })).toHaveFocus();
  });

  it("rejects a fractional token limit without sending a request", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("tab")).not.toBeInTheDocument();
    const tokenLimit = within(dialog).getByRole("textbox", { name: "Token limit" });
    await user.clear(tokenLimit);
    // A whole-number field refuses the decimal mark as it is typed...
    await user.type(tokenLimit, "1.5");
    expect(tokenLimit).toHaveValue("15");
    // ...and a pasted fraction is still caught on submit.
    await user.clear(tokenLimit);
    await user.click(tokenLimit);
    await user.paste("1.5");
    // Next checks the step's fields and stays on it.
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    const error = await within(dialog).findByText("Token limit must be a whole number, 0 or more.");
    expect(within(dialog).getByText("Step 1 of 2 · Basics")).toBeInTheDocument();
    // Only the failing field is marked and described; the credit limit stays untouched.
    expect(tokenLimit).toHaveAttribute("aria-invalid", "true");
    // Focus moves to the bad field.
    expect(tokenLimit).toHaveFocus();
    expect(tokenLimit.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    const creditLimit = within(dialog).getByRole("textbox", { name: "Credit limit" });
    expect(creditLimit).not.toHaveAttribute("aria-invalid", "true");
    expect(creditLimit.getAttribute("aria-describedby") ?? "").not.toContain(error.id);
    expect(sent("POST", "/api-keys")).toHaveLength(0);
  });

  it("shows a server error inside the dialog", async () => {
    const { user } = await renderPage();
    const existing = mockDb.apiKeys[3]?.key ?? "";
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Custom key (optional)" }),
      existing,
    );
    await toAccessStep(user, dialog);
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    expect(await within(dialog).findByText("This API key already exists.")).toBeInTheDocument();
    expect(screen.queryByTestId("created-key-panel")).not.toBeInTheDocument();
    // At the end of a scrolling form: the error is brought into view.
    expect(scrolled.mock.contexts).toContain(within(dialog).getByRole("alert"));
    scrolled.mockRestore();
  });

  it("copies the full key of a row from GET /api-keys/{id}", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(within(keysTable()).getByRole("button", { name: "Copy API key team-a" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));
    expect(await copyTextMock.mock.calls[0]?.[0]).toBe(teamA?.key);
    expect(sent("GET", `/api-keys/${teamA?.id}`)).toHaveLength(1);
  });

  it("disables a key with PUT {enabled:false} and no confirm", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
    await waitFor(() => expect(sent("PUT", `/api-keys/${teamA?.id}`)).toHaveLength(1));
    expect(sent("PUT", `/api-keys/${teamA?.id}`)[0]?.body).toEqual({ enabled: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("says Disabling… in the row while it runs, then Disabled", async () => {
    const put = gate();
    mockServer.use(
      http.put(apiUrl("/api-keys/:id"), async () => {
        await put.wait();
      }),
    );
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
    expect(await within(row("team-a")).findByText("Disabling…")).toBeInTheDocument();
    put.release();
    expect(await within(row("team-a")).findByText("Disabled")).toBeInTheDocument();
    expect(within(row("team-a")).queryByText("Disabling…")).not.toBeInTheDocument();
    await expectAnnounced("The API key was disabled.");
  });

  it("shows a failed disable in the card, and Try again sends it again", async () => {
    let fail = true;
    mockServer.use(
      http.put(apiUrl("/api-keys/:id"), () =>
        fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined,
      ),
    );
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
    const notice = await actionError();
    expect(within(row("team-a")).getByText("Enabled")).toBeInTheDocument();
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent("PUT", `/api-keys/${teamA?.id}`)).toHaveLength(2));
    expect(await within(row("team-a")).findByText("Disabled")).toBeInTheDocument();
    noActionError();
    // The notice is gone; focus is on the key's row menu, not the page.
    expect(document.activeElement).toHaveAccessibleName("Actions for team-a");
  });

  it("keeps a key whose delete failed and says so until it is closed", async () => {
    mockServer.use(
      http.delete(apiUrl("/api-keys/:id"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    const notice = await actionError();
    expect(row("team-a")).toBeInTheDocument();
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    noActionError();
    expect(document.activeElement).toHaveAccessibleName("Actions for team-a");
  });

  it("says Resetting… in the usage while a reset runs", async () => {
    const post = gate();
    const teamA = mockDb.apiKeys[0];
    mockServer.use(
      http.post(apiUrl("/api-keys/:id/reset-usage"), async () => {
        await post.wait();
      }),
    );
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset usage" }));
    expect(await within(row("team-a")).findByText("Resetting…")).toBeInTheDocument();
    post.release();
    await waitFor(() => expect(sent("POST", `/api-keys/${teamA?.id}/reset-usage`)).toHaveLength(1));
    await waitFor(() =>
      expect(within(row("team-a")).queryByText("Resetting…")).not.toBeInTheDocument(),
    );
  });

  it("resets usage without a confirm", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset usage" }));
    await waitFor(() => expect(sent("POST", `/api-keys/${teamA?.id}/reset-usage`)).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(await screen.findByText("The key's usage was reset.")).toBeInTheDocument();
  });

  it("regenerates a key only after the confirm and shows the new key once", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    const oldKey = teamA?.key;
    const path = `/api-keys/${teamA?.id}/regenerate`;
    const openConfirm = async () => {
      await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
      await user.click(await screen.findByRole("menuitem", { name: "Regenerate key" }));
      return screen.findByRole("alertdialog");
    };

    let confirm = await openConfirm();
    expect(within(confirm).getByText("Regenerate team-a?")).toBeInTheDocument();
    expect(
      within(confirm).getByText(/The current key stops working right away/),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(sent("POST", path)).toHaveLength(0);
    expect(mockDb.apiKeys[0]?.key).toBe(oldKey);

    confirm = await openConfirm();
    await user.click(within(confirm).getByRole("button", { name: "Regenerate key" }));
    const panel = await screen.findByTestId("created-key-panel");
    expect(sent("POST", path)).toHaveLength(1);
    const newKey = mockDb.apiKeys[0]?.key ?? "";
    expect(newKey).toMatch(/^sk-[0-9a-f]{64}$/);
    expect(newKey).not.toBe(oldKey);
    expect(
      within(panel).getByText(`${newKey.slice(0, 6)}****${newKey.slice(-4)}`),
    ).toBeInTheDocument();
    // Same key: id, name and usage stay.
    expect(mockDb.apiKeys[0]).toMatchObject({
      id: teamA?.id,
      name: "team-a",
      tokensUsed: 1_874_210,
    });

    await user.click(within(panel).getByRole("button", { name: "Copy new API key" }));
    expect(copyTextMock).toHaveBeenCalledWith(newKey);
    await user.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("created-key-panel")).not.toBeInTheDocument();
    expect(screen.queryByText(newKey)).not.toBeInTheDocument();
  });

  it("binds a key to picked accounts (search, masked under privacy)", async () => {
    const { user } = renderWithProviders(<ApiPage />, { privacy: true });
    await screen.findAllByText("team-a");
    const dana = mockDb.accounts[0];
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    await toAccessStep(user, dialog);
    await user.click(scopeRadio(dialog, "Accounts", "Only selected"));

    // "Only selected" with nothing picked would mean every account: the form refuses it.
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    expect(
      await within(dialog).findByText("Pick at least one account or tag, or choose All accounts."),
    ).toBeInTheDocument();
    const search = within(dialog).getByRole("searchbox", { name: "Search accounts" });
    expect(search).toHaveFocus();
    expect(sent("POST", "/api-keys")).toHaveLength(0);

    // Privacy mode hides the address, and the search cannot find the hidden part.
    await user.type(search, "whitfield");
    expect(within(dialog).getByText("No matches")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "team primary");
    const option = within(dialog).getByRole("checkbox", { name: /da\*\*\*@no\*\*\*\.com/ });
    expect(within(dialog).queryByText(dana?.email ?? "", { exact: false })).not.toBeInTheDocument();
    await user.click(option);
    expect(option).toBeChecked();
    expect(within(dialog).getByText(`1 of ${mockDb.accounts.length} selected`)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    await screen.findByTestId("created-key-panel");
    expect(sent("POST", "/api-keys")[0]?.body).toMatchObject({ accountIds: [dana?.id] });
    expect(mockDb.apiKeys.at(-1)?.accountIds).toEqual([dana?.id]);
    expect(await within(keysTable()).findByText("1 account")).toBeInTheDocument();
  });

  it("saves a key's tags, models, RPM limit, expiry and routing mode, and shows them", async () => {
    const [first, second, third] = mockDb.accounts;
    if (!first || !second || !third) throw new Error("missing seeded data");
    first.tags = ["team-eu"];
    second.tags = ["Team-EU", "ops"];
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "scoped");
    // The expiry presets count from today, each to the end of its day.
    await user.click(within(dialog).getByRole("button", { name: /^Expires/ }));
    await user.click(await screen.findByRole("button", { name: "In 7 days" }));
    expect(within(dialog).getByRole("button", { name: /^Expires/ })).not.toHaveTextContent(
      "Never expires",
    );
    const rpm = within(dialog).getByRole("textbox", { name: "Requests per minute" });
    await user.clear(rpm);
    await user.type(rpm, "30");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(scopeRadio(dialog, "Accounts", "Only selected"));
    // The tag picks accounts on its own: both spellings count, and the count says so.
    await user.click(within(dialog).getByRole("checkbox", { name: /team-eu/ }));
    expect(
      within(dialog).getByText(`2 of ${mockDb.accounts.length} accounts in scope`),
    ).toBeInTheDocument();
    // "Only selected models" with none ticked is refused, like accounts.
    await user.click(scopeRadio(dialog, "Allowed models", "Only selected"));
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    expect(
      await within(dialog).findByText("Pick at least one model, or choose Every model."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("searchbox", { name: "Search models" })).toHaveFocus();
    await user.click(await within(dialog).findByRole("checkbox", { name: "claude-haiku-4.5" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "auto" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Routing mode" }));
    await user.click(await screen.findByRole("option", { name: "Reset first" }));
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));

    await screen.findByTestId("created-key-panel");
    expect(sent("POST", "/api-keys")[0]?.body).toMatchObject({
      name: "scoped",
      accountIds: [],
      accountTags: ["team-eu"],
      allowedModels: ["claude-haiku-4.5", "auto"],
      rpmLimit: 30,
      expiresAt: expiryInDays(7),
      routingMode: "reset_first",
    });
    const created = row("scoped");
    expect(within(created).getByText("team-eu")).toBeInTheDocument();
    expect(within(created).getByText("2 models")).toBeInTheDocument();
    expect(within(created).getByText("30/min")).toBeInTheDocument();
    expect(within(created).getByText("Reset first")).toBeInTheDocument();
    expect(within(created).getByText("Enabled")).toBeInTheDocument();
    // Fills six fields; on a loaded runner the whole run can pass the 5 s default.
  }, 15_000);

  it("shows Expired for a key past its expiry and warns before saving a past time", async () => {
    const local = mockDb.apiKeys[3];
    if (!local) throw new Error("missing seeded key");
    local.expiresAt = Math.floor(Date.now() / 1000) - 60;
    const { user } = await renderPage();
    const expiredRow = row("local-dev");
    expect(within(expiredRow).getByText("Expired")).toBeInTheDocument();
    expect(within(expiredRow).queryByText("Enabled")).not.toBeInTheDocument();
    expect(within(row("team-a")).queryByText("Expired")).not.toBeInTheDocument();

    await user.click(within(keysTable()).getByRole("button", { name: "Actions for local-dev" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("This time has passed: clients get 401 as soon as you save."),
    ).toBeInTheDocument();
    // Never lets the key work again.
    await user.click(within(dialog).getByRole("button", { name: /^Expires/ }));
    await user.click(await screen.findByRole("button", { name: "Never" }));
    expect(within(dialog).getByRole("button", { name: /^Expires/ })).toHaveTextContent(
      "Never expires",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PUT", `/api-keys/${local.id}`)).toHaveLength(1));
    expect(sent("PUT", `/api-keys/${local.id}`)[0]?.body).toMatchObject({ expiresAt: 0 });
    // Save reads "Saved" for a moment, then the sheet closes on the updated row.
    expect(await within(dialog).findByRole("button", { name: "Saved" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await within(row("local-dev")).findByText("Enabled")).toBeInTheDocument();
  });

  it("picks an expiry day from the calendar, which ends with that day", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Expires/ }));
    await user.click(await screen.findByRole("button", { name: "Next month" }));
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth() + 1, 15);
    const label = new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(day);
    await user.click(await screen.findByRole("button", { name: label }));
    await toAccessStep(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    await screen.findByTestId("created-key-panel");
    expect(sent("POST", "/api-keys")[0]?.body).toMatchObject({ expiresAt: endOfLocalDay(day) });
  });

  it("edits a key in a sheet that keeps its models, including one no longer offered", async () => {
    const teamA = mockDb.apiKeys[0];
    if (!teamA) throw new Error("missing seeded key");
    teamA.allowedModels = ["claude-haiku-4.5", "retired-model"];
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const sheet = await screen.findByRole("dialog");
    // Every section at once, under its heading: no tabs in the sheet.
    expect(within(sheet).queryByRole("tab")).not.toBeInTheDocument();
    for (const heading of ["General", "Limits", "Access"]) {
      expect(within(sheet).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(scopeRadio(sheet, "Allowed models", "Only selected")).toBeChecked();
    const retired = await within(sheet).findByRole("checkbox", { name: "retired-model" });
    expect(retired).toBeChecked();
    await user.click(retired);
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PUT", `/api-keys/${teamA.id}`)).toHaveLength(1));
    expect(sent("PUT", `/api-keys/${teamA.id}`)[0]?.body).toMatchObject({
      allowedModels: ["claude-haiku-4.5"],
    });
  });

  it("shows tags, accounts and models only under Only selected", async () => {
    const first = mockDb.accounts[0];
    if (!first) throw new Error("missing seeded data");
    first.tags = ["team-eu"];
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const sheet = await screen.findByRole("dialog");
    expect(scopeRadio(sheet, "Accounts", "All accounts")).toBeChecked();
    expect(within(sheet).queryByRole("searchbox", { name: "Search accounts" })).toBeNull();
    expect(within(sheet).queryByRole("checkbox", { name: /team-eu/ })).toBeNull();
    expect(within(sheet).queryByRole("searchbox", { name: "Search models" })).toBeNull();
    await user.click(scopeRadio(sheet, "Accounts", "Only selected"));
    expect(await within(sheet).findByRole("checkbox", { name: /team-eu/ })).toBeInTheDocument();
    await user.click(scopeRadio(sheet, "Allowed models", "Only selected"));
    expect(await within(sheet).findByRole("checkbox", { name: "auto" })).toBeInTheDocument();
  });

  it("keeps a key's accounts while the account list fails to load", async () => {
    const teamA = mockDb.apiKeys[0];
    const [first, second] = mockDb.accounts;
    if (!teamA || !first || !second) throw new Error("missing seeded data");
    teamA.accountIds = [first.id, second.id];
    mockServer.use(
      http.get(apiUrl("/accounts"), () => HttpResponse.json({ error: "boom" }, { status: 500 })),
    );
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");

    // Unknown until the list loads: the picks must not look like deleted accounts.
    expect(await within(dialog).findByText("Could not load accounts")).toBeInTheDocument();
    expect(within(dialog).queryByText("Deleted account")).not.toBeInTheDocument();
    // The count line ("2 of 7 selected"), not the Only selected switches.
    expect(within(dialog).queryByText(/ of \d+ selected$/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PUT", `/api-keys/${teamA.id}`)).toHaveLength(1));
    expect(sent("PUT", `/api-keys/${teamA.id}`)[0]?.body).toMatchObject({
      accountIds: [first.id, second.id],
    });
  });

  it("shows successful calls against the call limit", async () => {
    const teamA = mockDb.apiKeys[0];
    const localDev = mockDb.apiKeys[3];
    if (!teamA || !localDev) throw new Error("missing seeded keys");
    teamA.callLimit = 20;
    teamA.successfulCalls = 20;
    localDev.callLimit = 5;
    localDev.successfulCalls = 2;
    const { user } = await renderPage();

    const teamRow = row("team-a");
    const calls = (key: HTMLElement) => key.querySelector('[data-measure="calls"]');
    expect(calls(teamRow)).toHaveTextContent(/^20 \/ 20 100%$/);
    expect(calls(row("local-dev"))).toHaveTextContent(/^2 \/ 5 40%$/);

    // A used-up call limit flags the key, with its own hint: the key stays enabled.
    const badge = within(teamRow).getByRole("button", { name: "Limit reached" });
    await user.click(badge);
    expect(
      await screen.findByText(
        "The key reached its call limit, so clients get a 429 error. Raise the call limit or reset usage.",
      ),
    ).toBeInTheDocument();
    // The table shows the one pill: Limit reached stands in for Enabled, never Disabled.
    expect(within(teamRow).queryByText("Disabled")).not.toBeInTheDocument();
  });

  it("names what blocks a key in the proxy's order: disabled, expired, then a limit", async () => {
    const teamA = mockDb.apiKeys[0];
    const localDev = mockDb.apiKeys[3];
    if (!teamA || !localDev) throw new Error("missing seeded keys");
    // Switched off by the admin with its call limit used up: the switch blocks it first.
    teamA.enabled = false;
    teamA.callLimit = 20;
    teamA.successfulCalls = 20;
    // Past its expiry with its call limit used up: clients get 401 before any limit check.
    localDev.expiresAt = Math.floor(Date.now() / 1000) - 60;
    localDev.callLimit = 5;
    localDev.successfulCalls = 5;
    await renderPage();

    const teamRow = row("team-a");
    expect(within(teamRow).getByText("Disabled")).toBeInTheDocument();
    expect(within(teamRow).queryByText("Limit reached")).not.toBeInTheDocument();
    const localRow = row("local-dev");
    expect(within(localRow).getByText("Expired")).toBeInTheDocument();
    expect(within(localRow).queryByText("Limit reached")).not.toBeInTheDocument();
    // A token limit that turned the key off still says so.
    expect(within(row("ci-runner")).getByText("Limit reached")).toBeInTheDocument();
  });

  it("deletes a key only after the confirm", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Delete team-a?")).toBeInTheDocument();
    expect(
      within(confirm).getByText(
        "Clients that use it can no longer call the proxy. This cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(sent("DELETE", `/api-keys/${teamA?.id}`)).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(sent("DELETE", `/api-keys/${teamA?.id}`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("team-a")).not.toBeInTheDocument());
  });

  it("warns about a lockout when deleting the last enabled key while keys are required", async () => {
    mockDb.settings.requireApiKey = true;
    for (const apiKey of mockDb.apiKeys) apiKey.enabled = apiKey.name === "team-a";
    const { user } = await renderPage();
    await screen.findByText("Clients must send an API key");
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/Every client is locked out/)).toBeInTheDocument();
  });

  it("refuses to require an API key while no key is enabled", async () => {
    for (const apiKey of mockDb.apiKeys) apiKey.enabled = false;
    const { user } = await renderPage();
    await screen.findByText("Any client can call the proxy");
    await user.click(screen.getByRole("switch", { name: "Require an API key" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Create and enable at least one API key before you require one."),
    ).toBeInTheDocument();
    expect(settingsPosts).toHaveLength(0);
  });

  it("leaves the enabled-key check to the server while the key list failed to load", async () => {
    mockServer.use(
      http.get(apiUrl("/api-keys"), () => HttpResponse.json({ error: "boom" }, { status: 500 })),
    );
    const { user } = renderWithProviders(<ApiAccessCard />);
    await screen.findByText("Any client can call the proxy");
    await user.click(screen.getByRole("switch", { name: "Require an API key" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settingsPosts).toEqual([{ requireApiKey: true }]));
    expect(
      screen.queryByText("Create and enable at least one API key before you require one."),
    ).not.toBeInTheDocument();
  });

  it("lets the hint follow the switch and the footer flag the draft", async () => {
    const { user } = await renderPage();
    await screen.findByText("Any client can call the proxy");
    await user.click(screen.getByRole("switch", { name: "Require an API key" }));
    expect(screen.getByTestId("api-access-state")).toHaveTextContent(
      /^Clients must send an API key$/,
    );
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("requires an API key with POST /settings {requireApiKey:true} only", async () => {
    for (const apiKey of mockDb.apiKeys) apiKey.enabled = apiKey.name === "local-dev";
    const { user } = await renderPage();
    await screen.findByText("Any client can call the proxy");
    const toggle = screen.getByRole("switch", { name: "Require an API key" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settingsPosts).toEqual([{ requireApiKey: true }]));
    expect(await screen.findByText("Clients must send an API key")).toBeInTheDocument();
    // Save reads "Saved" for a moment.
    expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
    await expectAnnounced("Your settings were saved.");
  });

  it("shows a failed API access save in the card, and Try again sends the draft again", async () => {
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/settings"), () =>
        fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined,
      ),
    );
    for (const apiKey of mockDb.apiKeys) apiKey.enabled = apiKey.name === "local-dev";
    const { user } = await renderPage();
    await screen.findByText("Any client can call the proxy");
    await user.click(screen.getByRole("switch", { name: "Require an API key" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const notice = await actionError();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(settingsPosts).toEqual([{ requireApiKey: true }]));
    expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
    noActionError();
  });

  it("names a key card's limits and shows its last use as a live time", async () => {
    await renderPage();
    const cards = within(screen.getByRole("list", { name: "API keys" })).getAllByRole("listitem");
    const card = (name: string) => {
      const found = cards.find((item) => within(item).queryByText(name));
      if (!found) throw new Error(`no card for ${name}`);
      return found;
    };
    // No limits: the card names the infinity sign; the table shows each amount over it, under
    // its Tokens, Credits or Calls header.
    const limits = card("local-dev").querySelector('[data-slot="key-usage-unlimited"]');
    expect(limits).toHaveTextContent("Limits Unlimited");
    expect(card("local-dev")).toHaveTextContent("Never used");
    expect(row("local-dev").querySelector('[data-measure="tokens"]')).toHaveTextContent(
      /^0 \/ Unlimited$/,
    );
    // The relative time is a <time>, which keeps itself current and has the date as a tooltip.
    const lastUsed = within(card("team-a")).getByText("5 minutes ago");
    expect(lastUsed.tagName).toBe("TIME");
    expect(lastUsed).toHaveAttribute("datetime");
    expect(card("team-a")).toHaveTextContent("Last used 5 minutes ago");
  });

  it("shows the seven endpoint URLs on window.location.origin", async () => {
    await renderPage();
    const list = screen.getByRole("list", { name: "Endpoints" });
    const urls = within(list)
      .getAllByRole("listitem")
      .map((item) => item.querySelector('[data-slot="endpoint-url"]')?.textContent);
    const origin = window.location.origin;
    expect(urls).toEqual([
      `${origin}/v1/messages`,
      `${origin}/v1/messages/count_tokens`,
      `${origin}/v1/chat/completions`,
      `${origin}/v1/responses`,
      `${origin}/v1/models`,
      `${origin}/v1/codex/models`,
      `${origin}/v1/stats`,
    ]);
    expect(screen.getByRole("button", { name: "Copy Claude API endpoint" })).toBeInTheDocument();
  });

  it("builds the request for the picked API and language, SDK or plain HTTP", async () => {
    const { user } = await renderPage();
    const origin = window.location.origin;
    const request = () =>
      screen.getByRole("tabpanel", { name: "API request" }).querySelector("pre");
    expect(request()).toHaveTextContent(`curl "${origin}/v1/messages"`);
    // Curl has no SDK, so no switch.
    expect(screen.queryByRole("switch", { name: /SDK/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Responses/ }));
    await user.click(screen.getByRole("radio", { name: "Python" }));
    const sdk = screen.getByRole("switch", { name: "OpenAI SDK" });
    expect(sdk).toBeChecked();
    expect(request()).toHaveTextContent(`base_url="${origin}/v1"`);
    expect(request()).toHaveTextContent("client.responses.create(");

    await user.click(sdk);
    expect(sdk).not.toBeChecked();
    expect(request()).toHaveTextContent(`"${origin}/v1/responses"`);
    expect(request()).toHaveTextContent("requests.post(");

    await user.click(screen.getByRole("radio", { name: /Messages/ }));
    expect(screen.getByRole("switch", { name: "Anthropic SDK" })).not.toBeChecked();
  });

  it("keeps the picks for the next visit", async () => {
    const first = await renderPage();
    await first.user.click(screen.getByRole("radio", { name: "Go" }));
    first.unmount();
    await renderPage();
    expect(screen.getByRole("radio", { name: "Go" })).toBeChecked();
    expect(screen.getByText("main.go")).toBeInTheDocument();
  });

  it("renders client snippets for this origin with the placeholder env var", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    const panel = screen.getByRole("tabpanel", { name: "Codex" });
    expect(panel).toHaveTextContent(`base_url = "${window.location.origin}/v1"`);
    expect(panel).toHaveTextContent('env_key = "KIRO_API_KEY"');
  });

  it("keeps the inactive setup tabs out of the layout below xl, so the card follows the open tab", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    const card = screen.getByRole("region", { name: "Client setup" });
    const panels = [...card.querySelectorAll<HTMLElement>("[role=tabpanel]")];
    expect(panels).toHaveLength(3);
    // From xl the panels share one cell (no jump beside Endpoints); below it a closed one takes
    // no room.
    for (const panel of panels) {
      expect(panel).toHaveClass("[grid-area:1/1]", "max-xl:data-inactive:hidden");
    }
    // The panel it left closes once its exit transition ends.
    await waitFor(() =>
      expect(panels.filter((panel) => !panel.hasAttribute("data-inactive"))).toHaveLength(1),
    );
    expect(panels.find((panel) => !panel.hasAttribute("data-inactive"))).toHaveTextContent(
      "ANTHROPIC_BASE_URL",
    );
  });
});

describe("Endpoints and Client setup given Require API key (the key holder's page)", () => {
  async function renderCards(requireApiKey: boolean, model?: string) {
    const result = renderWithProviders(
      <>
        <EndpointsCard requireApiKey={requireApiKey} />
        <ClientSnippetsCard model={model} requireApiKey={requireApiKey} />
      </>,
    );
    await screen.findByRole("list", { name: "Endpoints" });
    return result;
  }

  it("reads /admin/api/settings without the prop, as on the admin page", async () => {
    mockDb.settings.requireApiKey = false;
    renderWithProviders(
      <>
        <EndpointsCard />
        <ClientSnippetsCard />
      </>,
    );
    expect(await screen.findByRole("note")).toHaveTextContent(
      "API keys are not required now, so any value works.",
    );
    expect(screen.getByTestId("endpoints-auth-hint")).toHaveTextContent(
      /^API keys are not required now, so clients need no key\./,
    );
    expect(sent("GET", "/settings").length).toBeGreaterThan(0);
  });

  it("reads no settings and speaks to the key holder while keys are required", async () => {
    mockDb.settings.requireApiKey = false;
    await renderCards(true);
    expect(screen.getByTestId("endpoints-auth-hint")).toHaveTextContent(
      /^Send your API key as Authorization: Bearer <key> or X-Api-Key: <key>\.$/,
    );
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(requests.filter((r) => r.path.startsWith("/admin/api"))).toEqual([]);
  });

  it("gives the same key hint when keys are not required, and asks for the given model", async () => {
    mockDb.settings.requireApiKey = true;
    const { user } = await renderCards(false, "claude-haiku-4.5");
    expect(screen.getByTestId("endpoints-auth-hint")).toHaveTextContent(
      /^Send your API key as Authorization: Bearer <key> or X-Api-Key: <key>\.$/,
    );
    // The key holder's panel says keys are not required in its own alert; the card speaks of
    // their one key, without the admin's "any value works".
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Client setup" })).toHaveTextContent(
      "Set KIRO_API_KEY to your API key first.",
    );
    const request = screen.getByRole("tabpanel", { name: "API request" }).querySelector("pre");
    expect(request).toHaveTextContent('"model": "claude-haiku-4.5"');
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("tabpanel", { name: "Codex" })).toHaveTextContent(
      'model = "claude-haiku-4.5"',
    );
    expect(requests.filter((r) => r.path.startsWith("/admin/api"))).toEqual([]);
  });
});
