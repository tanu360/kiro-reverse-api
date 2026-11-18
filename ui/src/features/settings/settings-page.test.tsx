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
import { SECTION_ID, type SettingsPageId } from "./sections/sections";
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

/** A line read out by the app's live region (announce()), not a visible notice. */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
}

async function renderPage(page: SettingsPageId = "requests") {
  const result = renderWithProviders(<SettingsPage page={page} />);
  // The last card to load is enough: every query resolves in the same tick in tests.
  if (page === "requests") {
    await screen.findByRole("switch", { name: "Allow overage" });
    await screen.findByRole("button", { name: "Mapping 1 actions" });
    await screen.findByLabelText("Trigger suffix");
  } else if (page === "server") {
    await screen.findByText("Preferred endpoint");
    await screen.findByText("127.0.0.1:1080");
  } else {
    await screen.findByRole("button", { name: "Change password" });
    await screen.findByRole("button", { name: "Add rule" });
    await screen.findByRole("button", { name: "Reset statistics" });
  }
  return result;
}

describe("SettingsPage", () => {
  it("shows the section nav", async () => {
    await renderPage();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  it("shows a cut section name whole when the keyboard reaches its link, not only on hover", async () => {
    // From xl the nav is the sidebar's rows, where a name can be cut beside its pill.
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("min-width: 1280px"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    // jsdom has no layout: "Stream integrity" reads as cut, every other name as whole.
    const cut = (element: Element) =>
      element.classList.contains("truncate") && element.textContent === "Stream integrity";
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return cut(this) ? 200 : 0;
    });
    try {
      const { user } = await renderPage();
      const nav = screen.getByRole("navigation", { name: "Settings sections" });
      const link = within(nav).getByRole("link", { name: /^Stream integrity/ });
      let tabs = 0;
      while (document.activeElement !== link && tabs < 60) {
        await user.tab();
        tabs += 1;
      }
      expect(link).toHaveFocus();
      await waitFor(() =>
        expect(document.querySelector("[data-slot=tooltip-popup]")).toHaveTextContent(
          "Stream integrity",
        ),
      );

      // A name that fits gets no tooltip.
      await user.tab();
      await waitFor(() => expect(document.querySelector("[data-slot=tooltip-popup]")).toBeNull());
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("saves the Usage switch as it is flipped, with no Save of its own", async () => {
    const { user } = await renderPage();
    const usage = section(SECTION_ID.usage);
    expect(within(usage).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    const toggle = within(usage).getByRole("switch", { name: "Allow overage" });
    await user.click(toggle);

    await expectAnnounced("Your settings were saved.");
    expect(await writes()).toEqual([
      { method: "POST", path: "/settings", body: { allowOverUsage: true } },
    ]);
    expect(mockDb.settings.allowOverUsage).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveFocus();
  });

  it("puts a switch back when its save fails", async () => {
    mockServer.use(
      http.post(apiUrl("/settings"), () =>
        HttpResponse.json({ error: "settings store unavailable" }, { status: 500 }),
      ),
    );
    const { user } = await renderPage();
    const toggle = within(section(SECTION_ID.routing)).getByRole("switch", {
      name: "Keep conversations on one account",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);

    // The reason only, under the switch's row.
    expect(await within(section(SECTION_ID.routing)).findByRole("alert")).toHaveTextContent(
      "settings store unavailable",
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("sends only the Auto-continue fields on its Save", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.autoContinue);
    const save = within(card).getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");

    await user.click(
      within(card).getByRole("switch", { name: "Continue answers cut off by the output limit" }),
    );
    await user.click(save);

    await expectAnnounced("Your settings were saved.");
    expect(await writes()).toEqual([
      { method: "POST", path: "/settings", body: { autoContinue: true, autoContinueMax: 3 } },
    ]);
    expect(mockDb.settings.autoContinue).toBe(true);
  });

  it("shows a field error for 11 continuations and sends nothing", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.autoContinue);
    const input = within(card).getByLabelText("Maximum continuations per answer");
    expect(
      within(card).getByText(/^Kiro stops a single answer at about 8,192 output/),
    ).toBeVisible();

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

  it("image resize card saves the toggle and limits and rejects out-of-range values", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.imageResize);
    const toggle = within(card).getByRole("switch", {
      name: "Shrink large images before sending them",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    const dimension = within(card).getByLabelText("Maximum width or height");
    const size = within(card).getByLabelText("Maximum file size");
    // The hints group their numbers as the fields do.
    expect(
      within(card).getByText(
        "In pixels, between 256 and 4,096. Claude scales larger images down to about 1,568 pixels anyway.",
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText(/^In KB, between 50 and 4,096\./)).toBeInTheDocument();

    await user.clear(dimension);
    await user.type(dimension, "4097");
    await user.clear(size);
    await user.type(size, "49");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(
      await within(card).findByText(
        "Maximum width or height must be a whole number between 256 and 4,096.",
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("Maximum file size must be a whole number between 50 and 4,096."),
    ).toBeInTheDocument();
    expect(dimension).toHaveAttribute("aria-invalid", "true");
    expect(size).toHaveAttribute("aria-invalid", "true");
    expect(await writes()).toEqual([]);

    await user.clear(dimension);
    await user.type(dimension, "1024");
    await user.clear(size);
    await user.type(size, "300");
    await user.click(toggle);
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await expectAnnounced("Your settings were saved.");
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/settings",
        body: { imageResize: false, imageResizeMaxDimension: 1024, imageResizeMaxKB: 300 },
      },
    ]);
    expect(mockDb.settings.imageResize).toBe(false);
    expect(mockDb.settings.imageResizeMaxKB).toBe(300);
  });

  it("sends the default suffix when the Thinking suffix is empty", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.thinking);

    await user.clear(within(card).getByLabelText("Trigger suffix"));
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await expectAnnounced("Your settings were saved.");
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

      // The server's code (model_mapping_duplicate) and model, not its English `error`.
      const reason = "gpt-5 is mapped more than once.";
      expect(await within(card).findByText(reason)).toBeInTheDocument();
      // The row says it, so the footer does not; a screen reader hears it at once.
      expect(card.querySelector('[data-slot="action-error"]')).toBeNull();
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="live-announcer"] [aria-live="assertive"]'),
        ).toHaveTextContent(reason),
      );

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

    it("resets to the nine defaults after confirmation, without a request", async () => {
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
      const { user } = renderWithProviders(<SettingsPage page="requests" />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Mapping 2 actions" })).toBeInTheDocument(),
      );
      const card = section(SECTION_ID.modelMappings);

      const reset = within(card).getByRole("button", { name: "Reset to defaults" });
      await user.click(reset);
      const dialog = await screen.findByRole("alertdialog");
      expect(
        within(dialog).getByText("Your 2 mappings are replaced by the 9 defaults when you save."),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Reset" }));

      await waitFor(() =>
        expect(mappingTexts(card)).toEqual(
          defaultModelMappings().map((rule) => `${rule.key} -> ${rule.value}`),
        ),
      );
      expect(within(card).getByRole("button", { name: "Save" })).not.toHaveAttribute(
        "aria-disabled",
      );
      // The list is the defaults now: Reset stays focusable but does nothing.
      expect(reset).toHaveAttribute("aria-disabled", "true");
      expect(await writes()).toEqual([]);
    });

    it("keeps the list when the reset is canceled", async () => {
      mockServer.use(
        http.get(apiUrl("/model-mappings"), () =>
          HttpResponse.json({
            mappings: [{ key: "a", value: "b" }],
            defaults: defaultModelMappings(),
          }),
        ),
      );
      const { user } = renderWithProviders(<SettingsPage page="requests" />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Mapping 1 actions" })).toBeInTheDocument(),
      );
      const card = section(SECTION_ID.modelMappings);

      await user.click(within(card).getByRole("button", { name: "Reset to defaults" }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(mappingTexts(card)).toEqual(["a -> b"]);
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

      await expectAnnounced("Your settings were saved.");
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

  describe("danger zone", () => {
    it("resets the statistics after confirmation, and the button says it is done", async () => {
      const { user } = await renderPage("security");
      const card = section(SECTION_ID.dangerZone);
      const reset = within(card).getByRole("button", { name: "Reset statistics" });

      await user.click(reset);
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Reset" }));

      await expectAnnounced("The statistics were reset.");
      expect(reset).toHaveTextContent("Done");
      expect(await writes()).toEqual([{ method: "POST", path: "/stats/reset", body: null }]);
    });

    it("shows a failed reset under its row, and Try again resets without asking", async () => {
      let fail = true;
      mockServer.use(
        http.post(apiUrl("/stats/reset"), () =>
          fail ? HttpResponse.json({ error: "store busy" }, { status: 500 }) : undefined,
        ),
      );
      const { user } = await renderPage("security");
      const card = section(SECTION_ID.dangerZone);
      const reset = within(card).getByRole("button", { name: "Reset statistics" });
      await user.click(reset);
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reset" }),
      );

      const notice = await within(card).findByRole("alert");
      expect(notice).toHaveTextContent(/^store busy$/);
      fail = false;
      await user.click(within(notice).getByRole("button", { name: "Try again" }));

      await expectAnnounced("The statistics were reset.");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
      expect(reset).toHaveFocus();
    });
  });

  describe("admin password", () => {
    it("rejects 7 characters without a request", async () => {
      const { user } = await renderPage("security");
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
      const { user } = await renderPage("security");
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

      await expectAnnounced("Your password was changed.");
      expect(within(card).getByRole("button", { name: "Saved" })).toBeInTheDocument();
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
      const { user } = await renderPage("server");
      const card = section(SECTION_ID.outboundProxy);
      expect(within(card).getByText("Via SOCKS5")).toBeInTheDocument();
      expect(within(card).getByText("Signs in as user")).toBeInTheDocument();

      const dialog = await openEditor(user);
      await user.clear(within(dialog).getByLabelText("Host"));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(within(dialog).getByText("Enter a proxy host.")).toBeInTheDocument();
      expect(await writes()).toEqual([]);
    });

    it("refuses a host with a port or a space in the field, as the server would", async () => {
      const { user } = await renderPage("server");
      const dialog = await openEditor(user);
      const host = within(dialog).getByLabelText("Host");
      const port = within(dialog).getByLabelText("Port");

      await user.clear(host);
      await user.type(host, "1.2.3.4:8080");
      await user.clear(port);
      await user.type(port, "9");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(
        within(dialog).getByText("Put the port in the Port field, not after the host."),
      ).toBeInTheDocument();

      await user.clear(host);
      await user.type(host, "exa mple.com");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(
        within(dialog).getByText("Enter a host name or IP address with no spaces or slashes."),
      ).toBeInTheDocument();
      expect(await writes()).toEqual([]);
    });

    it("shows the server's refusal in the dialog", async () => {
      mockServer.use(
        http.post(apiUrl("/proxy"), () =>
          HttpResponse.json(
            { error: "invalid proxy: url needs a port", code: "proxy_url_invalid" },
            { status: 400 },
          ),
        ),
      );
      const { user } = await renderPage("server");
      const dialog = await openEditor(user);
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      const notice = await within(dialog).findByRole("alert");
      expect(notice).toHaveTextContent(/^The proxy URL needs a host and a port from 1 to 65535/);
      // Over the dialog's buttons, and gone once the form changes.
      expect(
        notice.compareDocumentPosition(within(dialog).getByRole("button", { name: "Save" })) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await user.type(within(dialog).getByLabelText("Host"), "x");
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    });

    it("sends the encoded URL from the editor and shows the new route", async () => {
      const { user } = await renderPage("server");
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

      await expectAnnounced("Your settings were saved.");
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
      const { user } = await renderPage("server");
      const card = section(SECTION_ID.outboundProxy);

      await user.click(within(card).getByRole("button", { name: "Remove proxy" }));
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Remove proxy" }));

      await expectAnnounced("Your settings were saved.");
      expect(await writes()).toEqual([{ method: "POST", path: "/proxy", body: { proxyURL: "" } }]);
      expect(await within(card).findByText("Direct connection")).toBeInTheDocument();
      await waitFor(() =>
        expect(within(card).getByRole("button", { name: "Set up proxy" })).toHaveFocus(),
      );
    });

    it("moves focus to Set up once a removal goes through, from Try again too", async () => {
      let fail = true;
      mockServer.use(
        http.post(apiUrl("/proxy"), () =>
          fail ? HttpResponse.json({ error: "store busy" }, { status: 500 }) : undefined,
        ),
      );
      const { user } = await renderPage("server");
      const card = section(SECTION_ID.outboundProxy);
      await user.click(within(card).getByRole("button", { name: "Remove proxy" }));
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Remove proxy" }));

      const notice = await within(card).findByRole("alert");
      fail = false;
      await user.click(within(notice).getByRole("button", { name: "Try again" }));

      const setUp = await within(card).findByRole("button", { name: "Set up proxy" });
      await waitFor(() => expect(setUp).toHaveFocus());
    });

    it("keeps a save on its way busy when the dialog is closed and opened again", async () => {
      let land: () => void = () => {};
      mockServer.use(
        http.post(apiUrl("/proxy"), async () => {
          await new Promise<void>((resolve) => {
            land = resolve;
          });
          return undefined;
        }),
      );
      const { user } = await renderPage("server");
      let dialog = await openEditor(user);
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(await within(dialog).findByRole("button", { name: /Saving/ })).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Edit proxy" })).not.toBeInTheDocument(),
      );

      // Not a fresh, idle form that the first save then flips to Saved and closes.
      dialog = await openEditor(user);
      expect(within(dialog).getByRole("button", { name: /Saving/ })).toBeInTheDocument();
      land();
      await expectAnnounced("Your settings were saved.");
      expect(await writes()).toHaveLength(1);
    });
  });

  it("adds a rule in the editor, hints at a bad regex and still saves it", async () => {
    const { user } = await renderPage("security");
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

    await expectAnnounced("Your settings were saved.");
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
    const { user } = await renderPage("security");
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

    // The fixture has the built-ins off and its rule on: mixed, so the checkbox reads mixed.
    const all = within(card).getByRole("checkbox", { name: "All filters and rules" });
    expect(all).toHaveAccessibleDescription("1 of 4 filters on");
    expect(all).toHaveAttribute("aria-checked", "mixed");
    await user.click(all);
    expect(all).toBeChecked();
    for (const control of within(card).getAllByRole("switch")) expect(control).toBeChecked();
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await expectAnnounced("Your settings were saved.");
    const [write] = await writes("/prompt-filter");
    expect(write.body).toMatchObject({
      filterClaudeCode: true,
      filterEnvNoise: true,
      filterStripBoundaries: true,
      rules: [{ name: "Hosts", enabled: true }],
    });
  });

  it("resets statistics after confirmation and refreshes request views", async () => {
    const { user, queryClient } = await renderPage("security");
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

    expect(await screen.findByText("The statistics were reset.")).toBeInTheDocument();
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
