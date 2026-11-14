import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsPatch } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { ApiPage } from "./api-page";

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
  });

  it("creates a key and shows the full key once, ready to copy", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "  laptop  ");
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));

    const panel = await screen.findByTestId("created-key-panel");
    const created = mockDb.apiKeys.at(-1);
    expect(created?.name).toBe("laptop");
    expect(created?.key).toMatch(/^sk-[0-9a-f]{64}$/);
    expect(within(panel).getByText(created?.key ?? "")).toBeInTheDocument();
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

    await user.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("created-key-panel")).not.toBeInTheDocument();
  });

  it("rejects a fractional token limit without sending a request", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    const tokenLimit = within(dialog).getByRole("textbox", { name: "Token limit" });
    await user.clear(tokenLimit);
    await user.type(tokenLimit, "1.5");
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    const error = await within(dialog).findByText("Token limit must be a whole number, 0 or more.");
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
    await user.click(within(dialog).getByRole("button", { name: "Create API key" }));
    expect(await within(dialog).findByText("This API key already exists.")).toBeInTheDocument();
    expect(screen.queryByTestId("created-key-panel")).not.toBeInTheDocument();
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
    expect(within(panel).getByText(newKey)).toBeInTheDocument();
    expect(within(panel).getByText(/The old key no longer works/)).toBeInTheDocument();
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
    await user.click(within(dialog).getByRole("radio", { name: "Only selected accounts" }));

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
    await user.click(within(dialog).getByRole("radio", { name: "Only selected accounts" }));
    // The tag picks accounts on its own: both spellings count, and the count says so.
    await user.click(within(dialog).getByRole("checkbox", { name: /team-eu/ }));
    expect(
      within(dialog).getByText(`2 of ${mockDb.accounts.length} accounts in scope`),
    ).toBeInTheDocument();
    const rpm = within(dialog).getByRole("textbox", { name: "Requests per minute" });
    await user.clear(rpm);
    await user.type(rpm, "30");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Allowed models" }),
      "claude-haiku-4.5, auto",
    );
    fireEvent.change(within(dialog).getByLabelText("Expires"), {
      target: { value: "2031-05-06T07:08" },
    });
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
      expiresAt: Math.floor(new Date(2031, 4, 6, 7, 8).getTime() / 1000),
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
    // Clearing the time lets the key work again.
    fireEvent.change(within(dialog).getByLabelText("Expires"), { target: { value: "" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PUT", `/api-keys/${local.id}`)).toHaveLength(1));
    expect(sent("PUT", `/api-keys/${local.id}`)[0]?.body).toMatchObject({ expiresAt: 0 });
    expect(await within(row("local-dev")).findByText("Enabled")).toBeInTheDocument();
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
    expect(within(dialog).queryByText(/ selected$/)).not.toBeInTheDocument();

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
    expect(within(teamRow).getByText("Calls")).toBeInTheDocument();
    expect(within(teamRow).getByText("20 / 20")).toBeInTheDocument();
    expect(within(teamRow).getByLabelText("Successful calls: 20 of 20")).toBeInTheDocument();
    expect(within(row("local-dev")).getByText("2 / 5")).toBeInTheDocument();

    // A used-up call limit flags the key, with its own hint: the key stays enabled.
    const badge = within(teamRow).getByRole("button", { name: "Limit reached" });
    await user.click(badge);
    expect(
      await screen.findByText(
        "The key reached its call limit, so clients get a 429 error. Raise the call limit or reset usage.",
      ),
    ).toBeInTheDocument();
    expect(within(teamRow).getByText("Enabled")).toBeInTheDocument();
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
    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
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
