import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";

/** A page's row in the sidebar: the link that owns its tree of views or sub-pages. */
function treeRow(name: string): HTMLElement {
  const row = screen
    .getAllByRole("link", { name })
    .find((link) => link.hasAttribute("aria-expanded"));
  if (!row) throw new Error(`no ${name} row in the sidebar`);
  return row;
}

describe("sidebar tree", () => {
  it("unfolds only the open page's tree", async () => {
    await renderApp("/settings/server");
    await screen.findByRole("tab", { name: "Server", selected: true });
    expect(treeRow("Settings")).toHaveAttribute("aria-expanded", "true");
    expect(treeRow("Requests")).toHaveAttribute("aria-expanded", "false");
    expect(treeRow("Accounts")).toHaveAttribute("aria-expanded", "false");
  });

  it("moves the unfolded tree to the page it goes to", async () => {
    const { user, router } = await renderApp("/accounts");
    await waitFor(() => expect(treeRow("Accounts")).toHaveAttribute("aria-expanded", "true"));
    expect(treeRow("Settings")).toHaveAttribute("aria-expanded", "false");

    await user.click(treeRow("Settings"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(treeRow("Settings")).toHaveAttribute("aria-expanded", "true");
    expect(treeRow("Accounts")).toHaveAttribute("aria-expanded", "false");
  });
});
