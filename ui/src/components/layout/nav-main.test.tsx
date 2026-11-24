import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";

/** A page's row in the sidebar. */
function navRow(name: string): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "Main navigation" });
  return within(nav).getByRole("link", { name });
}

describe("sidebar", () => {
  it("keeps the page row selected on its sub-pages, which it does not list", async () => {
    await renderApp("/settings/server");
    await screen.findByRole("tab", { name: "Server", selected: true });
    expect(navRow("Settings")).toHaveAttribute("data-active", "true");
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).queryByRole("link", { name: "Server" })).toBeNull();
  });

  it("keeps the page row selected on a filtered view, which it does not list", async () => {
    await renderApp("/accounts?status=attention");
    expect(navRow("Accounts")).toHaveAttribute("data-active", "true");
    expect(navRow("Requests")).toHaveAttribute("data-active", "false");
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).queryByRole("link", { name: "Needs attention" })).toBeNull();
  });
});
