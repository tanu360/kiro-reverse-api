import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsPatch } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp, renderWithProviders } from "@/test/render";
import { ApiPage } from "./api-page";

// Focus, keyboard and layout behaviour of the API page (QA fixes).

// GET/POST /settings belong to the settings feature, so these tests serve them.
beforeEach(() => {
  mockServer.use(
    http.get(apiUrl("/settings"), () => HttpResponse.json(mockDb.settings)),
    http.post(apiUrl("/settings"), async ({ request }) => {
      Object.assign(mockDb.settings, (await request.json()) as SettingsPatch);
      return HttpResponse.json({ success: true });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderPage() {
  const result = renderWithProviders(<ApiPage />);
  await screen.findAllByText("team-a");
  return result;
}

function keysTable(): HTMLElement {
  return screen.getByRole("table", { name: "API keys" });
}

/** Thirty keys: more than a page of cards (10) or table rows (25). */
function seedManyKeys(): void {
  const first = mockDb.apiKeys[0];
  if (!first) throw new Error("no seeded key");
  mockDb.apiKeys.splice(0);
  for (let index = 0; index < 30; index++) {
    const id = `key-${index}`;
    mockDb.apiKeys.push({ ...first, id, name: `client-${index}`, key: `sk-${id}`, keyMasked: id });
  }
}

describe("API keys layout", () => {
  it("renders the keys as cards too, shown by CSS while the card is narrow", async () => {
    const { user } = await renderPage();
    const cards = screen.getByRole("list", { name: "API keys" });
    expect(cards.closest('[data-slot="data-table-cards"]')).toHaveClass("@4xl/data-table:hidden");
    expect(within(cards).getAllByRole("listitem")).toHaveLength(mockDb.apiKeys.length);
    // Every row's actions stay one tap away in the card layout.
    await user.click(within(cards).getByRole("button", { name: "Actions for ci-runner" }));
    expect(await screen.findByRole("menuitem", { name: "Reset usage" })).toBeInTheDocument();
  });

  it("pins the actions column to the end of the table", async () => {
    await renderPage();
    const trigger = within(keysTable()).getByRole("button", { name: "Actions for team-a" });
    expect(trigger.closest("td")).toHaveClass("sticky", "right-0");
  });

  it("pages the table 25 keys at a time in the card footer", async () => {
    seedManyKeys();
    const { user } = renderWithProviders(<ApiPage />);
    await screen.findAllByText("client-0");
    expect(within(keysTable()).getAllByRole("row")).toHaveLength(26);
    expect(screen.getByText("1–25 of 30")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(within(keysTable()).getAllByRole("row")).toHaveLength(6);
    expect(within(keysTable()).getByText("client-29")).toBeInTheDocument();
  });
});

describe("API keys focus", () => {
  it("keeps the row menu trigger enabled and focused while Reset usage runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      http.post(apiUrl("/api-keys/:id/reset-usage"), async () => {
        await gate;
        return undefined;
      }),
    );
    const { user } = await renderPage();
    const trigger = within(keysTable()).getByRole("button", { name: "Actions for team-a" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Reset usage" }));
    await waitFor(() => expect(trigger).toHaveAttribute("aria-busy", "true"));
    expect(trigger).toBeEnabled();
    await waitFor(() => expect(trigger).toHaveFocus());
    release();
    expect(await screen.findByText("Usage reset")).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).not.toHaveAttribute("aria-busy");
  });

  it("keeps focus on the row menu trigger after Disable", async () => {
    const { user } = await renderPage();
    const trigger = within(keysTable()).getByRole("button", { name: "Actions for team-a" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
    expect(await screen.findByText("API key disabled")).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("moves focus to the next row's menu after a delete", async () => {
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("team-a")).not.toBeInTheDocument());
    // The neighbour's trigger: the one in the layout on screen (jsdom shows both).
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Actions for Unnamed key" })).toContain(
        document.activeElement,
      ),
    );
  });

  it("moves focus to Create API key after the last key is deleted", async () => {
    mockDb.apiKeys.splice(1);
    const { user } = await renderPage();
    await user.click(within(keysTable()).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument();
    const header = screen.getByRole("region", { name: "API keys" });
    await waitFor(() =>
      expect(within(header).getAllByRole("button", { name: "Create API key" })[0]).toHaveFocus(),
    );
  });

  it("opens the limit-reached hint on a tap, not only on hover", async () => {
    const { user } = await renderPage();
    const badge = within(keysTable()).getByRole("button", { name: "Limit reached" });
    expect(badge).toHaveAttribute("aria-expanded", "false");
    await user.click(badge);
    expect(badge).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText(/Raise the limit or reset usage/)).toBeVisible();
  });
});

describe("API access", () => {
  it("keeps focus on Save when it turns inert after saving", async () => {
    for (const apiKey of mockDb.apiKeys) apiKey.enabled = true;
    const { user } = await renderPage();
    await screen.findByText("Any client can call the proxy");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("switch", { name: "Require an API key" }));
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(save);
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
    expect(save).toHaveFocus();
    expect(save).toBeEnabled();
  });

  it("asks before leaving the page with an unsaved change", async () => {
    const { user, router } = await renderApp("/api");
    await screen.findByText("Any client can call the proxy");
    await user.click(screen.getByRole("switch", { name: "Require an API key" }));

    act(() => {
      void router.navigate({ to: "/settings" });
    });
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Discard unsaved changes?")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/api");
    expect(screen.getByRole("switch", { name: "Require an API key" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    act(() => {
      void router.navigate({ to: "/settings" });
    });
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });

  it("leaves without asking when nothing changed", async () => {
    const { router } = await renderApp("/api");
    await screen.findByText("Any client can call the proxy");
    act(() => {
      void router.navigate({ to: "/settings" });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("Client setup snippets", () => {
  function overflow(scrollWidth: number, clientWidth: number): void {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
  }

  it("names a code block that scrolls sideways as a region around its scroller", async () => {
    overflow(900, 300);
    const { user } = await renderPage();
    const block = screen.getByRole("region", { name: "Anthropic Messages API code" });
    expect(block.tagName).toBe("SECTION");
    expect(block.querySelector("pre")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("region", { name: "~/.codex/config.toml code" })).toBeInTheDocument();
  });

  it("adds no region to a code block that fits", async () => {
    overflow(300, 300);
    await renderPage();
    expect(
      screen.queryByRole("region", { name: "Anthropic Messages API code" }),
    ).not.toBeInTheDocument();
    for (const pre of document.querySelectorAll("pre")) {
      expect(pre).not.toHaveAttribute("tabindex");
    }
  });
});
