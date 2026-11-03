import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsPatch } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp, renderWithProviders } from "@/test/render";
import { KEYS_TABLE_MIN_WIDTH } from "./api-keys-card";
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

/** Lays out every element at `width` px, so the keys card measures that content width. */
function layoutWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width, height: 100 }),
  );
}

describe("API keys layout", () => {
  it("shows cards while the card is narrower than the table, whatever the viewport", async () => {
    layoutWidth(KEYS_TABLE_MIN_WIDTH - 200);
    const { user } = await renderPage();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const cards = screen.getByRole("list", { name: "API keys" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(mockDb.apiKeys.length);
    // Every row's actions stay one tap away in the card layout.
    await user.click(within(cards).getByRole("button", { name: "Actions for ci-runner" }));
    expect(await screen.findByRole("menuitem", { name: "Reset usage" })).toBeInTheDocument();
  });

  it("shows the table, with a sticky actions column, once the card is wide enough", async () => {
    layoutWidth(KEYS_TABLE_MIN_WIDTH + 40);
    await renderPage();
    const table = screen.getByRole("table", { name: "API keys" });
    expect(screen.queryByRole("list", { name: "API keys" })).not.toBeInTheDocument();
    const trigger = within(table).getByRole("button", { name: "Actions for team-a" });
    expect(trigger.closest("td")).toHaveClass("sticky", "right-0");
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
    const trigger = screen.getByRole("button", { name: "Actions for team-a" });
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
    const trigger = screen.getByRole("button", { name: "Actions for team-a" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
    expect(await screen.findByText("API key disabled")).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("moves focus to the next row's menu after a delete", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("team-a")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actions for Unnamed key" })).toHaveFocus(),
    );
  });

  it("moves focus to Create API key after the last key is deleted", async () => {
    mockDb.apiKeys.splice(1);
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Actions for team-a" }));
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
    const badge = screen.getByRole("button", { name: "Limit reached" });
    expect(badge).toHaveAttribute("aria-expanded", "false");
    await user.click(badge);
    expect(badge).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText(/Raise the limit or reset usage/)).toBeVisible();
  });
});

describe("API access", () => {
  it("moves focus to the switch when Save turns disabled after saving", async () => {
    for (const apiKey of mockDb.apiKeys) apiKey.enabled = true;
    const { user } = await renderPage();
    await screen.findByText("Any client can call the proxy");
    const toggle = screen.getByRole("switch", { name: "Require an API key" });
    await user.click(toggle);
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    await waitFor(() => expect(save).toBeDisabled());
    await waitFor(() => expect(toggle).toHaveFocus());
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

  it("makes a code block that scrolls sideways a labelled tab stop", async () => {
    overflow(900, 300);
    const { user } = await renderPage();
    const block = screen.getByRole("region", { name: "Anthropic Messages API code" });
    expect(block.tagName).toBe("PRE");
    expect(block).toHaveAttribute("tabindex", "0");
    block.focus();
    expect(block).toHaveFocus();
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("region", { name: "~/.codex/config.toml code" })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("adds no tab stop to a code block that fits", async () => {
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
