import { screen, waitFor, within } from "@testing-library/react";
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

function row(name: string): HTMLElement {
  const cell = screen.getByText(name);
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no row for ${name}`);
  return tr;
}

async function renderPage() {
  const result = renderWithProviders(<ApiPage />);
  await screen.findByText("team-a");
  return result;
}

describe("ApiPage", () => {
  it("lists the seeded keys with masked values and flags the limit-reached key", async () => {
    await renderPage();
    for (const apiKey of mockDb.apiKeys) {
      expect(screen.getByText(apiKey.keyMasked)).toBeInTheDocument();
      // Keys up to 10 characters are their own mask (Go MaskApiKey).
      if (apiKey.key !== apiKey.keyMasked) {
        expect(screen.queryByText(apiKey.key, { exact: false })).not.toBeInTheDocument();
      }
    }
    expect(within(row("ci-runner")).getByText("Limit reached")).toBeInTheDocument();
    expect(within(row("team-a")).queryByText("Limit reached")).not.toBeInTheDocument();
    expect(screen.getAllByText("Limit reached")).toHaveLength(1);
    expect(screen.getByText("Unnamed key")).toBeInTheDocument();
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
    expect(
      await within(dialog).findByText(
        "Token limit must be a whole number, and limits cannot be negative.",
      ),
    ).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Copy API key team-a" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));
    expect(await copyTextMock.mock.calls[0]?.[0]).toBe(teamA?.key);
    expect(sent("GET", `/api-keys/${teamA?.id}`)).toHaveLength(1);
  });

  it("disables a key with PUT {enabled:false} and no confirm", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(screen.getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
    await waitFor(() => expect(sent("PUT", `/api-keys/${teamA?.id}`)).toHaveLength(1));
    expect(sent("PUT", `/api-keys/${teamA?.id}`)[0]?.body).toEqual({ enabled: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resets usage without a confirm", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(screen.getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset usage" }));
    await waitFor(() => expect(sent("POST", `/api-keys/${teamA?.id}/reset-usage`)).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(await screen.findByText("Usage reset")).toBeInTheDocument();
  });

  it("deletes a key only after the confirm", async () => {
    const { user } = await renderPage();
    const teamA = mockDb.apiKeys[0];
    await user.click(screen.getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Delete this API key?")).toBeInTheDocument();
    expect(within(confirm).getByText("Clients using it stop working.")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/every client is locked out/)).toBeInTheDocument();
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
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
  });

  it("shows the six endpoint URLs on window.location.origin", async () => {
    await renderPage();
    const list = screen.getByRole("list", { name: "Endpoints" });
    const urls = within(list)
      .getAllByRole("listitem")
      .map((item) => item.querySelector("code")?.textContent);
    const origin = window.location.origin;
    expect(urls).toEqual([
      `${origin}/v1/messages`,
      `${origin}/v1/chat/completions`,
      `${origin}/v1/responses`,
      `${origin}/v1/models`,
      `${origin}/v1/codex/models`,
      `${origin}/v1/stats`,
    ]);
    expect(screen.getByRole("button", { name: "Copy Claude API endpoint" })).toBeInTheDocument();
  });

  it("renders client snippets for this origin with the placeholder env var", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    const panel = screen.getByRole("tabpanel", { name: "Codex" });
    expect(panel).toHaveTextContent(`base_url = "${window.location.origin}/v1"`);
    expect(panel).toHaveTextContent('env_key = "KIRO_API_KEY"');
  });
});
