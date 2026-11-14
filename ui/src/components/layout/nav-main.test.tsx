import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";

/** The Settings row of the sidebar: the link that owns the sub-page tree. */
function settingsRow(): HTMLElement {
  const row = screen
    .getAllByRole("link", { name: "Settings" })
    .find((link) => link.hasAttribute("aria-expanded"));
  if (!row) throw new Error("no Settings row in the sidebar");
  return row;
}

describe("sidebar tree", () => {
  it("folds and unfolds Settings from any of its pages, staying on that page", async () => {
    const { user, router } = await renderApp("/settings/server");
    await screen.findByRole("tab", { name: "Server", selected: true });
    expect(settingsRow()).toHaveAttribute("aria-expanded", "true");

    await user.click(settingsRow());
    await waitFor(() => expect(settingsRow()).toHaveAttribute("aria-expanded", "false"));
    expect(router.state.location.pathname).toBe("/settings/server");

    await user.click(settingsRow());
    await waitFor(() => expect(settingsRow()).toHaveAttribute("aria-expanded", "true"));
    expect(router.state.location.pathname).toBe("/settings/server");
  });

  it("goes to Settings from another page", async () => {
    const { user, router } = await renderApp("/api");
    await user.click(settingsRow());
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(settingsRow()).toHaveAttribute("aria-expanded", "true");
  });
});
