import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp, renderWithProviders } from "@/test/render";
import { SECTION_ID, SETTINGS_SECTIONS } from "./sections/sections";
import { SettingsPage } from "./settings-page";

let writes: string[] = [];

function onRequestStart({ request }: { request: Request }): void {
  if (request.method !== "GET") writes.push(new URL(request.url).pathname);
}

beforeEach(() => {
  writes = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
  vi.restoreAllMocks();
});

function section(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`section ${id} not rendered`);
  return element;
}

async function renderPage() {
  const result = renderWithProviders(<SettingsPage />);
  await screen.findByRole("switch", { name: "Allow overage" });
  await screen.findAllByRole("textbox", { name: "Model name contains" });
  await screen.findByRole("button", { name: "Add regex rule" });
  await screen.findByText("Proxy type");
  return result;
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Settings sections" });
}

describe("settings focus", () => {
  it("keeps focus on Save after a save, with Save blocked while clean", async () => {
    const { user } = await renderPage();
    const usage = section(SECTION_ID.usage);
    const save = within(usage).getByRole("button", { name: "Save" });

    await user.click(within(usage).getByRole("switch", { name: "Allow overage" }));
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(save);

    await screen.findByText("Settings saved");
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).not.toBeDisabled();
    expect(save).toHaveFocus();

    // A blocked Save sends nothing, by click or by the form's implicit Enter submission.
    writes = [];
    await user.click(save);
    const suffix = within(section(SECTION_ID.thinking)).getByLabelText("Trigger suffix");
    await user.click(suffix);
    await user.keyboard("{Enter}");
    expect(writes).toEqual([]);
  });

  it("keeps the Change password button focusable while it works", async () => {
    let release: () => void = () => {};
    mockServer.use(
      http.post(apiUrl("/settings"), async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ ok: true });
      }),
    );
    const { user } = await renderPage();
    const card = section(SECTION_ID.adminPassword);
    await user.type(within(card).getByLabelText("New password"), "a-new-password");
    await user.click(within(card).getByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Change password" }));

    const busy = await within(card).findByRole("button", { name: "Changing…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).not.toBeDisabled();
    await act(async () => release());
  });

  describe("model mapping", () => {
    it("has Save in the card footer, not beside Add mapping", async () => {
      await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const save = within(card).getByRole("button", { name: "Save" });
      const footer = card.querySelector('[data-slot="card-footer"]');
      expect(footer).not.toBeNull();
      expect(footer).toContainElement(save);
    });

    it("moves focus to the next row's Match field after Remove", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const rows = within(card).getAllByRole("listitem");

      await user.click(within(rows[0]).getByRole("button", { name: "Remove" }));

      const sources = within(card).getAllByRole("textbox", { name: "Model name contains" });
      expect(sources).toHaveLength(8);
      await waitFor(() => expect(sources[0]).toHaveFocus());
    });

    it("moves focus to the previous row after removing the last, then to Add mapping", async () => {
      mockServer.use(
        http.get(apiUrl("/model-mappings"), () =>
          HttpResponse.json({
            mappings: [
              { key: "a", value: "b" },
              { key: "c", value: "d" },
            ],
            defaults: [],
          }),
        ),
      );
      const { user } = renderWithProviders(<SettingsPage />);
      await waitFor(() =>
        expect(screen.getAllByRole("textbox", { name: "Model name contains" })).toHaveLength(2),
      );
      const card = section(SECTION_ID.modelMappings);

      await user.click(within(card).getAllByRole("button", { name: "Remove" })[1]);
      const [first] = within(card).getAllByRole("textbox", { name: "Model name contains" });
      await waitFor(() => expect(first).toHaveFocus());

      await user.click(within(card).getByRole("button", { name: "Remove" }));
      await waitFor(() =>
        expect(within(card).getByRole("button", { name: "Add mapping" })).toHaveFocus(),
      );
    });

    it("keeps a focused row mounted when the saved list comes back from the server", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const [source] = within(card).getAllByRole("textbox", { name: "Model name contains" });

      await user.clear(source);
      await user.type(source, "GPT-X");
      await user.keyboard("{Enter}");

      await screen.findByText("Settings saved");
      // The server lowercases keys; the refetched copy replaces the clean draft in place.
      await waitFor(() =>
        expect(
          within(card).getAllByRole("textbox", { name: "Model name contains" })[0],
        ).toHaveValue("gpt-x"),
      );
      expect(within(card).getAllByRole("textbox", { name: "Model name contains" })[0]).toBe(source);
      expect(source).toHaveFocus();
    });

    it("labels the stacked inputs on phones", async () => {
      await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const [row] = within(card).getAllByRole("listitem");
      const [source] = within(row).getAllByRole("textbox", { name: "Model name contains" });
      const label = row.querySelector(`label[for="${source.id}"]`);
      expect(label).toHaveTextContent("Model name contains");
      expect(label).toHaveClass("sm:hidden");
    });
  });

  describe("section nav", () => {
    it("moves focus to the card heading and marks the link current", async () => {
      const { user } = await renderPage();
      const link = within(nav()).getByRole("link", { name: "Outbound proxy" });

      await user.click(link);

      const heading = within(section(SECTION_ID.outboundProxy)).getByRole("heading", {
        name: "Outbound proxy",
      });
      expect(heading).toHaveFocus();
      expect(link).toHaveAttribute("aria-current", "true");
      expect(within(nav()).getByRole("link", { name: "Usage" })).not.toHaveAttribute(
        "aria-current",
      );
    });

    it("follows the card scrolled under the header", async () => {
      await renderPage();
      const tops = new Map<string, number>(
        SETTINGS_SECTIONS.map((entry, index) => [entry.id, index * 400 - 1300]),
      );
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const top = tops.get(this.id) ?? 0;
        return { top, bottom: top + 380, left: 0, right: 0, width: 0, height: 380 } as DOMRect;
      });

      // Card 4 (index 3) is at -100, card 5 at 300: Auto-continue is in view.
      await act(async () => {
        window.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      await waitFor(() =>
        expect(within(nav()).getByRole("link", { name: "Auto-continue" })).toHaveAttribute(
          "aria-current",
          "true",
        ),
      );
    });

    it("marks a card with unsaved edits", async () => {
      const { user } = await renderPage();
      expect(within(nav()).queryByText("(unsaved changes)")).not.toBeInTheDocument();
      await user.click(screen.getByRole("switch", { name: "Allow overage" }));
      const usage = within(nav()).getByRole("link", { name: /Usage/ });
      expect(within(usage).getByText("(unsaved changes)")).toBeInTheDocument();
    });
  });

  it("gives touch-size targets to switch labels, section chips and rule inputs", async () => {
    const { user } = await renderPage();
    // A t3code row title on a mouse; 40 px tall on a touch screen.
    const label = within(section(SECTION_ID.usage)).getByText("Allow overage");
    expect(label).toHaveClass("pointer-coarse:min-h-10");
    expect(within(nav()).getByRole("link", { name: "Usage" })).toHaveClass("min-h-10");

    const filter = section(SECTION_ID.promptFilter);
    await user.click(within(filter).getByRole("button", { name: "Add regex rule" }));
    const [rule] = within(filter).getAllByRole("listitem");
    for (const input of within(rule).getAllByRole("textbox")) {
      const control = input.closest('[data-slot="input-control"]');
      expect(control).toHaveAttribute("data-size", "default");
      expect(control?.className).toContain("pointer-coarse:*:data-[slot=input]:h-9.5");
    }
  });

  it("shows one error for the cards built on the shared settings query", async () => {
    mockServer.use(
      http.get(apiUrl("/settings"), () =>
        HttpResponse.json({ error: "settings store unavailable" }, { status: 500 }),
      ),
    );
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Could not load settings")).toBeInTheDocument();
    await screen.findByText("Proxy type");
    expect(screen.queryByText("Could not load this data")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow overage" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    // The hidden anchors keep the nav working: it goes to the error instead.
    expect(section(SECTION_ID.usage)).not.toBeVisible();
  });
});

describe("leaving with unsaved edits", () => {
  it("asks before leaving and stays when you keep editing", async () => {
    const { user, router } = await renderApp("/settings");
    await user.click(await screen.findByRole("switch", { name: "Allow overage" }));

    const [apiLink] = screen.getAllByRole("link", { name: "API" });
    await user.click(apiLink);
    const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/settings");
    expect(screen.getByRole("switch", { name: "Allow overage" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(apiLink);
    const again = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await user.click(within(again).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/api"));
  });

  it("leaves a clean page without asking", async () => {
    const { user, router } = await renderApp("/settings");
    await screen.findByRole("switch", { name: "Allow overage" });
    const [apiLink] = screen.getAllByRole("link", { name: "API" });
    await user.click(apiLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/api"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
