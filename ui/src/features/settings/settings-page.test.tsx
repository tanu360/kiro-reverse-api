import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/query-keys";
import { REMEMBER_KEY, setSession, TOKEN_KEY } from "@/lib/auth/session";
import { mockDb } from "@/lib/mocks/db";
import { defaultModelMappings } from "@/lib/mocks/fixtures";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { SECTION_ID } from "./sections/sections";
import { SettingsPage } from "./settings-page";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let recorded: Array<Promise<Recorded>> = [];

function onRequestStart({ request }: { request: Request }): void {
  const path = new URL(request.url).pathname.replace(/^\/admin\/api/, "");
  recorded.push(
    request
      .clone()
      .text()
      .then((text) => ({ method: request.method, path, body: text ? JSON.parse(text) : null })),
  );
}

/** Every write the page sent, in order. */
async function writes(path?: string): Promise<Recorded[]> {
  const all = await Promise.all(recorded);
  return all.filter((r) => r.method !== "GET" && (path === undefined || r.path === path));
}

beforeEach(() => {
  recorded = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

function section(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`section ${id} not rendered`);
  return element;
}

async function renderPage() {
  const result = renderWithProviders(<SettingsPage />);
  // The last card to load is enough: every query resolves in the same tick in tests.
  await screen.findByRole("switch", { name: "Allow overage" });
  await screen.findAllByRole("textbox", { name: "Match contains" });
  await screen.findByLabelText("Trigger suffix");
  await screen.findByRole("button", { name: "Add regex rule" });
  await screen.findByText("Preferred endpoint");
  await screen.findByText("Proxy type");
  return result;
}

describe("SettingsPage", () => {
  it("shows the read-only listen address", async () => {
    await renderPage();
    expect(screen.getByText("Listening on 0.0.0.0:8080")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  it("sends only the Usage field on its Save", async () => {
    const { user } = await renderPage();
    const usage = section(SECTION_ID.usage);
    const save = within(usage).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.click(within(usage).getByRole("switch", { name: "Allow overage" }));
    await user.click(save);

    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    expect(await writes()).toEqual([
      { method: "POST", path: "/settings", body: { allowOverUsage: true } },
    ]);
    expect(mockDb.settings.allowOverUsage).toBe(true);
  });

  it("shows a field error for 11 continuations and sends nothing", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.autoContinue);
    const input = within(card).getByLabelText("Maximum continuations per answer");

    await user.clear(input);
    await user.type(input, "11");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(
      await within(card).findByText(
        "Maximum continuations must be a whole number between 1 and 10.",
      ),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(await writes()).toEqual([]);
  });

  it("sends the default suffix when the Thinking suffix is empty", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.thinking);

    await user.clear(within(card).getByLabelText("Trigger suffix"));
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await screen.findByText("Settings saved");
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/thinking",
        body: { suffix: "-thinking", openaiFormat: "reasoning_content", claudeFormat: "thinking" },
      },
    ]);
    expect(within(card).getByLabelText("Trigger suffix")).toHaveValue("-thinking");
  });

  describe("model mappings", () => {
    it("adds an empty row at the top and focuses it", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const before = within(card).getAllByRole("textbox", { name: "Match contains" });
      expect(before).toHaveLength(9);

      await user.click(within(card).getByRole("button", { name: "Add mapping" }));

      const after = within(card).getAllByRole("textbox", { name: "Match contains" });
      expect(after).toHaveLength(10);
      expect(after[0]).toHaveValue("");
      expect(after[1]).toHaveValue("claude-sonnet-4-20250514");
      await waitFor(() => expect(after[0]).toHaveFocus());
    });

    it("maps the server's index back to the offending row and focuses it", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);

      await user.click(within(card).getByRole("button", { name: "Add mapping" }));
      // A blank row stays blank: it is dropped before sending, so indexes shift.
      await user.click(within(card).getByRole("button", { name: "Add mapping" }));
      const sources = within(card).getAllByRole("textbox", { name: "Match contains" });
      const targets = within(card).getAllByRole("textbox", { name: "Map to" });
      await user.type(sources[1], "GPT-5");
      await user.type(targets[1], "claude-opus-5");
      await user.click(within(card).getByRole("button", { name: "Save" }));

      const reason = 'source "gpt-5" is mapped more than once';
      expect(await within(card).findByText(reason)).toBeInTheDocument();
      // Error toasts are high priority: the text also lands in an announcement region.
      expect(
        (await screen.findAllByText(`Could not save settings: ${reason}`)).length,
      ).toBeGreaterThan(0);

      const [write] = await writes("/model-mappings");
      const sent = (write.body as { mappings: unknown[] }).mappings;
      expect(sent).toHaveLength(10);
      expect(sent[0]).toEqual({ key: "GPT-5", value: "claude-opus-5" });

      // Sent index 7 is the built-in gpt-5 row, local row 8 after the two added rows.
      const rows = within(card).getAllByRole("listitem");
      expect(rows[8]).toHaveAttribute("data-error", "true");
      const offending = within(rows[8]).getByRole("textbox", { name: "Match contains" });
      expect(offending).toHaveValue("gpt-5");
      await waitFor(() => expect(offending).toHaveFocus());
    });

    it("resets to the nine defaults without a request", async () => {
      mockServer.use(
        http.get(apiUrl("/model-mappings"), () =>
          HttpResponse.json({
            mappings: [
              { key: "a", value: "b" },
              { key: "c", value: "d" },
            ],
            defaults: defaultModelMappings(),
          }),
        ),
      );
      const { user } = renderWithProviders(<SettingsPage />);
      await waitFor(() =>
        expect(screen.getAllByRole("textbox", { name: "Match contains" })).toHaveLength(2),
      );
      const card = section(SECTION_ID.modelMappings);

      await user.click(within(card).getByRole("button", { name: "Reset to defaults" }));

      const sources = within(card).getAllByRole("textbox", { name: "Match contains" });
      expect(sources.map((input) => (input as HTMLInputElement).value)).toEqual(
        defaultModelMappings().map((rule) => rule.key),
      );
      expect(within(card).getByRole("button", { name: "Save" })).toBeEnabled();
      expect(await writes()).toEqual([]);
    });

    it("saves the order changed with the keyboard through Move down", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const [moveDown] = within(card).getAllByRole("button", { name: "Move down" });

      moveDown.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(within(card).getAllByRole("button", { name: "Move down" })[1]).toHaveFocus(),
      );
      await user.click(within(card).getByRole("button", { name: "Save" }));

      await screen.findByText("Settings saved");
      const [write] = await writes("/model-mappings");
      const defaults = defaultModelMappings();
      expect((write.body as { mappings: unknown[] }).mappings).toEqual([
        defaults[1],
        defaults[0],
        ...defaults.slice(2),
      ]);
    });
  });

  describe("admin password", () => {
    it("rejects 7 characters without a request", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.adminPassword);

      await user.click(within(card).getByRole("button", { name: "Change password" }));
      expect(within(card).getByText("Enter a new password.")).toBeInTheDocument();

      await user.type(within(card).getByLabelText("New password"), "1234567");
      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(within(card).getByText("Password must be at least 8 characters.")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(await writes()).toEqual([]);
    });

    it("changes the password after confirmation and signs in again", async () => {
      const { user } = await renderPage();
      act(() => {
        setSession({ token: "mock-before", expiresAt: Date.now() + 3_600_000, remember: true });
      });
      const card = section(SECTION_ID.adminPassword);

      await user.type(within(card).getByLabelText("New password"), "correct horse");
      await user.click(within(card).getByRole("button", { name: "Change password" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Change the admin password?")).toBeInTheDocument();
      expect(within(dialog).getByText("All other signed-in sessions end.")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(await screen.findByText("Password changed")).toBeInTheDocument();
      expect(await writes()).toEqual([
        { method: "POST", path: "/settings", body: { password: "correct horse" } },
        { method: "POST", path: "/session", body: { password: "correct horse" } },
      ]);
      const token = localStorage.getItem(TOKEN_KEY);
      expect(token).toMatch(/^mock-/);
      expect(token).not.toBe("mock-before");
      expect(localStorage.getItem(REMEMBER_KEY)).toBe("1");
      expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(within(card).getByLabelText("New password")).toHaveValue("");
    });
  });

  describe("outbound proxy", () => {
    it("requires a host for SOCKS5", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.outboundProxy);

      await user.clear(within(card).getByLabelText("Host"));
      await user.click(within(card).getByRole("button", { name: "Save" }));

      expect(within(card).getByText("Enter a proxy host and port.")).toBeInTheDocument();
      expect(await writes()).toEqual([]);
    });

    it("sends the encoded URL", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.outboundProxy);
      expect(within(card).getByLabelText("Password")).toHaveValue("p@ss");

      await user.clear(within(card).getByLabelText("Host"));
      await user.type(within(card).getByLabelText("Host"), "proxy.example");
      await user.clear(within(card).getByLabelText("Username"));
      await user.type(within(card).getByLabelText("Username"), "us@r");
      await user.clear(within(card).getByLabelText("Password"));
      await user.type(within(card).getByLabelText("Password"), "p:ss");
      await user.click(within(card).getByRole("button", { name: "Save" }));

      await screen.findByText("Settings saved");
      expect(await writes()).toEqual([
        {
          method: "POST",
          path: "/proxy",
          body: { proxyURL: "socks5://us%40r:p%3Ass@proxy.example:1080" },
        },
      ]);
    });
  });

  it("appends a rule, hints at a bad regex and still saves it", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.promptFilter);
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);

    await user.click(within(card).getByRole("button", { name: "Add regex rule" }));
    const rules = within(card).getAllByRole("listitem");
    expect(rules).toHaveLength(3);
    const added = rules[2];
    expect(added).toHaveAccessibleName("Rule 3");
    await user.type(within(added).getByLabelText("Match"), "(");

    expect(
      within(added).getByText("This regex does not compile; the proxy skips it."),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await screen.findByText("Settings saved");
    const [write] = await writes("/prompt-filter");
    const body = write.body as { rules: Array<Record<string, unknown>> };
    expect(Object.keys(body).sort()).toEqual([
      "filterClaudeCode",
      "filterEnvNoise",
      "filterStripBoundaries",
      "rules",
    ]);
    expect(body.rules).toHaveLength(3);
    expect(body.rules[0].name).toBe("Hide internal hostnames");
    expect(body.rules[2]).toMatchObject({
      type: "regex",
      match: "(",
      replace: "",
      enabled: true,
      name: "",
    });
    expect(body.rules[2].id).toMatch(/^rule-\d+$/);
  });

  it("resets statistics after confirmation and refreshes request views", async () => {
    const { user, queryClient } = await renderPage();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const card = section(SECTION_ID.dangerZone);

    await user.click(within(card).getByRole("button", { name: "Reset statistics" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "Request history and error logs are deleted. Per-account and per-key usage stay. This cannot be undone.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));

    expect(await screen.findByText("Statistics reset")).toBeInTheDocument();
    expect(await writes()).toEqual([{ method: "POST", path: "/stats/reset", body: null }]);
    expect(mockDb.requests).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.status });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.observe.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.requests.all });
  });

  it("keeps a dirty card when a refetch brings a new server copy", async () => {
    const { user, queryClient } = await renderPage();
    const card = section(SECTION_ID.thinking);
    const suffix = within(card).getByLabelText("Trigger suffix");

    await user.clear(suffix);
    await user.type(suffix, "-local");
    mockDb.thinking.suffix = "-server";
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.thinking() });
    });

    expect(await within(card).findByText("Changed on the server")).toBeInTheDocument();
    expect(suffix).toHaveValue("-local");

    await user.click(within(card).getByRole("button", { name: "Reload" }));
    expect(within(card).getByLabelText("Trigger suffix")).toHaveValue("-server");
    expect(within(card).queryByText("Changed on the server")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("lets a clean card take a refetched server copy", async () => {
    const { queryClient } = await renderPage();
    mockDb.settings.allowOverUsage = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
    });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Allow overage" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  });
});
