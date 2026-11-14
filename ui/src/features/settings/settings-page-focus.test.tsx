import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp, renderWithProviders } from "@/test/render";
import { pageSections, SECTION_ID, type SettingsPageId } from "./sections/sections";
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

async function renderPage(page: SettingsPageId = "requests") {
  const result = renderWithProviders(<SettingsPage page={page} />);
  if (page === "requests") {
    await screen.findByRole("switch", { name: "Allow overage" });
    await screen.findByRole("button", { name: "Mapping 1 actions" });
    await screen.findByRole("button", { name: "Add rule" });
  } else if (page === "server") {
    await screen.findByText("127.0.0.1:1080");
  } else {
    await screen.findByRole("button", { name: "Change password" });
    await screen.findByRole("button", { name: "Reset statistics" });
  }
  return result;
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Settings sections" });
}

describe("settings focus", () => {
  it("keeps focus on Save after a save, with Save blocked while clean", async () => {
    const { user } = await renderPage();
    const card = section(SECTION_ID.autoContinue);
    const save = within(card).getByRole("button", { name: "Save" });

    await user.click(
      within(card).getByRole("switch", { name: "Continue answers cut off by the output limit" }),
    );
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(save);

    await screen.findByText("Your settings were saved.");
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
    const { user } = await renderPage("security");
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

    it("moves focus to the next row's menu after Delete", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);

      await user.click(within(card).getByRole("button", { name: "Mapping 1 actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete mapping" }));

      expect(within(card).getAllByRole("listitem")).toHaveLength(8);
      await waitFor(() =>
        expect(within(card).getByRole("button", { name: "Mapping 1 actions" })).toHaveFocus(),
      );
    });

    it("moves focus to the previous row after deleting the last, then to Add mapping", async () => {
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
      const { user } = renderWithProviders(<SettingsPage page="requests" />);
      await user.click(await screen.findByRole("button", { name: "Mapping 2 actions" }));
      const card = section(SECTION_ID.modelMappings);
      await user.click(await screen.findByRole("menuitem", { name: "Delete mapping" }));
      await waitFor(() =>
        expect(within(card).getByRole("button", { name: "Mapping 1 actions" })).toHaveFocus(),
      );

      await user.click(within(card).getByRole("button", { name: "Mapping 1 actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete mapping" }));
      await waitFor(() =>
        expect(within(card).getByRole("button", { name: "Add mapping" })).toHaveFocus(),
      );
    });

    it("keeps an edited row mounted when the saved list comes back from the server", async () => {
      const { user } = await renderPage();
      const card = section(SECTION_ID.modelMappings);
      const [row] = within(card).getAllByRole("listitem");

      await user.click(within(card).getByRole("button", { name: "Mapping 1 actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Edit mapping" }));
      const dialog = await screen.findByRole("dialog", { name: "Edit mapping" });
      const source = within(dialog).getByLabelText("Model name contains");
      await user.clear(source);
      await user.type(source, "GPT-X{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await user.click(within(card).getByRole("button", { name: "Save" }));

      await screen.findByText("Your settings were saved.");
      // The server lowercases keys; the refetched copy replaces the clean draft in place.
      await waitFor(() =>
        expect(within(card).getAllByRole("listitem")[0]).toHaveTextContent("gpt-x"),
      );
      expect(within(card).getAllByRole("listitem")[0]).toBe(row);
    });
  });

  describe("section nav", () => {
    it("moves focus to the card heading and marks the link current", async () => {
      const { user } = await renderPage("server");
      const link = within(nav()).getByRole("link", { name: "Outbound proxy" });

      await user.click(link);

      const heading = within(section(SECTION_ID.outboundProxy)).getByRole("heading", {
        name: "Outbound proxy",
      });
      expect(heading).toHaveFocus();
      expect(link).toHaveAttribute("aria-current", "true");
      expect(within(nav()).getByRole("link", { name: "Kiro endpoint" })).not.toHaveAttribute(
        "aria-current",
      );
    });

    it("follows the card scrolled under the header", async () => {
      await renderPage();
      const tops = new Map<string, number>(
        pageSections("requests").map((entry, index) => [entry.id, index * 400 - 1300]),
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

    it("keeps a section opened from the nav marked at the page end until the reader scrolls", async () => {
      const { user } = await renderPage("security");
      // The page end on a phone: Log retention sits at the top, Danger zone under it, and the
      // page cannot scroll further, where the spy alone marks the last card.
      const sections = pageSections("security");
      const last = sections.length - 1;
      const tops = new Map<string, number>(
        sections.map((entry, index) => [entry.id, (index - last + 1) * 490 + 147]),
      );
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const top = tops.get(this.id) ?? 0;
        return { top, bottom: top + 470, left: 0, right: 0, width: 0, height: 470 } as DOMRect;
      });
      const root = document.documentElement;
      const ownScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
      Object.defineProperty(root, "scrollHeight", { configurable: true, value: 10_000 });
      Object.defineProperty(window, "scrollY", {
        configurable: true,
        value: 10_000 - window.innerHeight,
      });
      const frame = () =>
        act(async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });
      // The name, with "(unsaved changes)" after it once the Space below flips the switch.
      const current = (name: string) =>
        expect(within(nav()).getByRole("link", { name: new RegExp(`^${name}`) })).toHaveAttribute(
          "aria-current",
          "true",
        );
      try {
        await user.click(within(nav()).getByRole("link", { name: "Log retention" }));
        current("Log retention");

        // A later scroll that the reader did not start keeps it (the cards above it can still
        // be loading), and so does a key that scrolls nothing (Space on a switch in the card).
        await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
        window.dispatchEvent(new Event("scroll"));
        await frame();
        current("Log retention");
        const card = section(SECTION_ID.logRetention);
        within(card).getAllByRole("switch")[0]?.focus();
        await user.keyboard(" ");
        await frame();
        current("Log retention");

        // The reader scrolls the page: the spy takes over and marks the last card.
        await act(async () => {
          window.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
          window.dispatchEvent(new Event("scroll"));
        });
        await frame();
        await waitFor(() => current("Danger zone"));
      } finally {
        delete (root as { scrollHeight?: number }).scrollHeight;
        if (ownScrollY) Object.defineProperty(window, "scrollY", ownScrollY);
        else delete (window as { scrollY?: number }).scrollY;
      }
    });

    it("marks a card with unsaved edits", async () => {
      const { user } = await renderPage();
      expect(within(nav()).queryByText("(unsaved changes)")).not.toBeInTheDocument();
      await user.click(
        screen.getByRole("switch", { name: "Continue answers cut off by the output limit" }),
      );
      const link = within(nav()).getByRole("link", { name: /Auto-continue/ });
      expect(within(link).getByText("(unsaved changes)")).toBeInTheDocument();
    });
  });

  it("gives touch-size targets to section chips and rule inputs", async () => {
    const { user } = await renderPage();
    // Below xl (and in tests, which match no media query) the nav is the chip row: 40 px chips.
    expect(within(nav()).getByRole("link", { name: "Usage" })).toHaveClass("min-h-10");

    const filter = section(SECTION_ID.promptFilter);
    await user.click(within(filter).getByRole("button", { name: "Add rule" }));
    const editor = await screen.findByRole("dialog", { name: "Add rule" });
    await user.click(within(editor).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Regex" }));
    // The Input sizes itself for touch (40 px with its border); no call site adds a class.
    for (const input of within(editor).getAllByRole("textbox")) {
      const control = input.closest('[data-slot="input-control"]');
      expect(control).toHaveAttribute("data-size", "default");
      expect(input.className).toContain("pointer-coarse:h-9.5");
    }
  });

  it("shows one error for the cards built on the shared settings query", async () => {
    mockServer.use(
      http.get(apiUrl("/settings"), () =>
        HttpResponse.json({ error: "settings store unavailable" }, { status: 500 }),
      ),
    );
    renderWithProviders(<SettingsPage page="requests" />);

    expect(await screen.findByText("Could not load settings")).toBeInTheDocument();
    await screen.findByLabelText("Trigger suffix");
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
    await user.click(
      await screen.findByRole("switch", { name: "Continue answers cut off by the output limit" }),
    );

    const [apiLink] = screen.getAllByRole("link", { name: "API" });
    await user.click(apiLink);
    const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/settings");
    expect(
      screen.getByRole("switch", { name: "Continue answers cut off by the output limit" }),
    ).toHaveAttribute("aria-checked", "true");

    await user.click(apiLink);
    const again = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await user.click(within(again).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/api"));
  });

  it("asks before another settings page drops the edits", async () => {
    const { user, router } = await renderApp("/settings");
    await user.click(
      await screen.findByRole("switch", { name: "Continue answers cut off by the output limit" }),
    );
    await user.click(screen.getByRole("tab", { name: "Server" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/server"));
    expect(await screen.findByRole("tab", { name: "Server", selected: true })).toBeInTheDocument();
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

describe("settings deep link", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("sends a link from before the split to the page its card is on", async () => {
    const { router } = await renderApp(`/settings#${SECTION_ID.alerts}`);
    expect(router.state.location.pathname).toBe("/settings/server");
    expect(router.state.location.hash).toBe(SECTION_ID.alerts);
    // Memory history leaves window.location alone, so the card's mark is the browser's to show;
    // here the Server page with its Alerts link is enough.
    expect(await screen.findByRole("tab", { name: "Server", selected: true })).toBeInTheDocument();
    const settingsNav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(settingsNav).getByRole("link", { name: /^Alerts/ })).toBeInTheDocument();
  });

  it("marks the linked section and scrolls its chip into the chip row once the chips widen", async () => {
    const callbacks = new Map<Element, () => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {}
        observe(target: Element): void {
          callbacks.set(target, this.callback);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    window.history.replaceState(null, "", `/settings/server#${SECTION_ID.alerts}`);
    try {
      await renderPage("server");
      const link = within(nav()).getByRole("link", { name: "Alerts" });
      expect(link).toHaveAttribute("aria-current", "true");

      // The On/Off pills have loaded and pushed the chip past the row's right edge.
      const viewport = nav().querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      const row = link.closest("ul")?.parentElement?.parentElement;
      if (!viewport || !row) throw new Error("chip row not rendered");
      Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 3000 });
      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 390 });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const box = this === link ? { left: 900, right: 990 } : { left: 0, right: 390 };
        return { ...box, top: 0, bottom: 40, width: box.right - box.left, height: 40 } as DOMRect;
      });
      const scrollY = window.scrollY;
      act(() => callbacks.get(row)?.());

      // 990 - 390, plus 32 px so the chip clears the row's edge fade; the page does not move.
      expect(viewport.scrollLeft).toBe(632);
      expect(window.scrollY).toBe(scrollY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("follows the column that holds every card, also for a card inside its own form", async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(target: Element): void {
          observed.push(target);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    window.history.replaceState(null, "", `/settings/security#${SECTION_ID.adminPassword}`);
    try {
      await renderPage("security");
      const card = section(SECTION_ID.adminPassword);
      const column = observed.find((target) => target.contains(card));
      expect(column).toBeDefined();
      // The column, not the card's form: every card of the page grows inside it.
      expect(column?.contains(section(SECTION_ID.dangerZone))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
