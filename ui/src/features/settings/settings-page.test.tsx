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
  await screen.findByRole("button", { name: "Mapping 1 actions" });
  await screen.findByLabelText("Trigger suffix");
  await screen.findByRole("button", { name: "Add rule" });
  await screen.findByText("Preferred endpoint");
  await screen.findByText("127.0.0.1:1080");
  return result;
}

describe("SettingsPage", () => {
  it("shows the section nav", async () => {
    await renderPage();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  it("sends only the Usage field on its Save", async () => {
    const { user } = await renderPage();
    const usage = section(SECTION_ID.usage);
    const save = within(usage).getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");

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
    /** The text of each mapping row, "key → value" without the number. */
    function mappingTexts(card: HTMLElement): string[] {
      return within(card)
        .getAllByRole("listitem")
        .map((row) =>
          [...row.querySelectorAll("code")].map((code) => code.textContent).join(" -> "),
        );
    }

    async function openRowMenu(
      user: Awaited<ReturnType<typeof renderPage>>["user"],
      card: HTMLElement,
      n: number,
    ) {
      await user.click(within(card).getByRole("button", { name: `Mapping ${n} actions` }));
    }

    it("adds a mapping at the top through the editor", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);
      expect(within(card).getAllByRole("listitem")).toHaveLength(9);

      await user.click(within(card).getByRole("button", { name: "Add mapping" }));
      const dialog = await screen.findByRole("dialog", { name: "Add mapping" });
      const apply = within(dialog).getByRole("button", { name: "Add mapping" });
      // Both sides are needed.
      expect(apply).toBeDisabled();
      await user.type(within(dialog).getByLabelText("Model name contains"), "my-model");
      expect(apply).toBeDisabled();
      await user.type(within(dialog).getByLabelText("Map to"), "claude-opus-5");
      await user.click(apply);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      const texts = mappingTexts(card);
      expect(texts).toHaveLength(10);
      expect(texts[0]).toBe("my-model -> claude-opus-5");
      expect(texts[1]).toBe("claude-sonnet-4-20250514 -> claude-sonnet-5");
      expect(await writes()).toEqual([]);
    });

    it("maps the server's index back to the offending row and focuses it", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);

      await user.click(within(card).getByRole("button", { name: "Add mapping" }));
      const dialog = await screen.findByRole("dialog", { name: "Add mapping" });
      await user.type(within(dialog).getByLabelText("Model name contains"), "GPT-5");
      await user.type(within(dialog).getByLabelText("Map to"), "claude-opus-5{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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

      // Sent index 7 is the built-in gpt-5 row, local row 7 after the added one.
      const rows = within(card).getAllByRole("listitem");
      expect(rows[7]).toHaveAttribute("data-error", "true");
      expect(rows[7]).toHaveTextContent("gpt-5");
      await waitFor(() =>
        expect(within(rows[7]).getByRole("button", { name: "Mapping 8 actions" })).toHaveFocus(),
      );
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
        expect(screen.getByRole("button", { name: "Mapping 2 actions" })).toBeInTheDocument(),
      );
      const card = section(SECTION_ID.modelMappings);

      await user.click(within(card).getByRole("button", { name: "Reset to defaults" }));

      expect(mappingTexts(card)).toEqual(
        defaultModelMappings().map((rule) => `${rule.key} -> ${rule.value}`),
      );
      expect(within(card).getByRole("button", { name: "Save" })).not.toHaveAttribute(
        "aria-disabled",
      );
      expect(await writes()).toEqual([]);
    });

    it("saves the order changed through Move down", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);

      await openRowMenu(user, card, 1);
      expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.click(screen.getByRole("menuitem", { name: "Move down" }));
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

    it("filters the list by either side and keeps each row's number", async () => {
      mockServer.use(
        http.get(apiUrl("/model-mappings"), () =>
          HttpResponse.json({
            mappings: defaultModelMappings(),
            defaults: defaultModelMappings(),
          }),
        ),
      );
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const defaults = defaultModelMappings();
      const needle = defaults[3].value;

      await user.type(within(card).getByRole("searchbox", { name: "Filter mappings" }), needle);

      const expected = defaults.filter(
        (rule) => rule.key.includes(needle) || rule.value.includes(needle),
      );
      expect(mappingTexts(card)).toEqual(expected.map((rule) => `${rule.key} -> ${rule.value}`));
      // No reordering while filtered.
      expect(within(card).queryByRole("button", { name: "Drag to reorder" })).toBeNull();
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
    async function openEditor(user: Awaited<ReturnType<typeof renderPage>>["user"]) {
      const card = section(SECTION_ID.outboundProxy);
      await user.click(within(card).getByRole("button", { name: "Edit" }));
      return screen.findByRole("dialog", { name: "Edit proxy" });
    }

    it("shows the saved route and requires a host and port before it saves", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.outboundProxy);
      expect(within(card).getByText("Via SOCKS5")).toBeInTheDocument();
      expect(within(card).getByText("Signs in as user")).toBeInTheDocument();

      const dialog = await openEditor(user);
      await user.clear(within(dialog).getByLabelText("Host"));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(within(dialog).getByText("Enter a proxy host and port.")).toBeInTheDocument();
      expect(await writes()).toEqual([]);
    });

    it("sends the encoded URL from the editor and shows the new route", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.outboundProxy);
      const dialog = await openEditor(user);
      expect(within(dialog).getByLabelText("Password")).toHaveValue("p@ss");

      await user.clear(within(dialog).getByLabelText("Host"));
      await user.type(within(dialog).getByLabelText("Host"), "proxy.example");
      await user.clear(within(dialog).getByLabelText("Username"));
      await user.type(within(dialog).getByLabelText("Username"), "us@r");
      await user.clear(within(dialog).getByLabelText("Password"));
      await user.type(within(dialog).getByLabelText("Password"), "p:ss");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await screen.findByText("Settings saved");
      expect(await writes()).toEqual([
        {
          method: "POST",
          path: "/proxy",
          body: { proxyURL: "socks5://us%40r:p%3Ass@proxy.example:1080" },
        },
      ]);
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Edit proxy" })).not.toBeInTheDocument(),
      );
      expect(within(card).getByText("proxy.example:1080")).toBeInTheDocument();
      expect(within(card).getByText("Signs in as us@r")).toBeInTheDocument();
    });

    it("removes the proxy after confirmation", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.outboundProxy);

      await user.click(within(card).getByRole("button", { name: "Remove proxy" }));
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Remove proxy" }));

      await screen.findByText("Settings saved");
      expect(await writes()).toEqual([{ method: "POST", path: "/proxy", body: { proxyURL: "" } }]);
      expect(await within(card).findByText("Direct connection")).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Set up proxy" })).toBeInTheDocument();
    });
  });

  it("adds a rule in the editor, hints at a bad regex and still saves it", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.promptFilter);
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);

    await user.click(within(card).getByRole("button", { name: "Add rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add rule" });
    const apply = within(dialog).getByRole("button", { name: "Add rule" });
    // Nothing to match yet: an empty line filter would drop every line.
    expect(apply).toBeDisabled();
    await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Regex" }));
    await user.type(within(dialog).getByLabelText("Match"), "(");
    expect(
      within(dialog).getByText("This regex does not compile; the proxy skips it."),
    ).toBeInTheDocument();
    await user.click(apply);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Applying writes the draft only; Save sends it.
    expect(await writes("/prompt-filter")).toHaveLength(0);

    const rules = within(card).getAllByRole("listitem");
    expect(rules).toHaveLength(3);
    const added = rules[2];
    expect(added).toHaveAccessibleName("Rule 3");
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

  it("edits and deletes a rule from its menu, and switches every filter at once", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.promptFilter);
    const [first] = within(card).getAllByRole("listitem");

    await user.click(
      within(first).getByRole("button", { name: "Rule actions: Hide internal hostnames" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit rule" });
    const name = within(dialog).getByLabelText("Rule name");
    await user.clear(name);
    await user.type(name, "Hosts{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(card).getAllByRole("listitem")[0]).toHaveTextContent("Hosts");

    await user.click(
      within(card).getByRole("button", { name: "Rule actions: Drop telemetry lines" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete rule" }));
    expect(within(card).getAllByRole("listitem")).toHaveLength(1);

    // The fixture has the built-ins off and its rule on: mixed, so the switch reads off.
    const all = within(card).getByRole("switch", { name: "All filters and rules" });
    expect(all).toHaveAccessibleDescription("1 of 4 filters on");
    expect(all).not.toBeChecked();
    await user.click(all);
    for (const control of within(card).getAllByRole("switch")) expect(control).toBeChecked();
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await screen.findByText("Settings saved");
    const [write] = await writes("/prompt-filter");
    expect(write.body).toMatchObject({
      filterClaudeCode: true,
      filterEnvNoise: true,
      filterStripBoundaries: true,
      rules: [{ name: "Hosts", enabled: true }],
    });
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
    expect(within(card).getByRole("button", { name: "Save" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
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
