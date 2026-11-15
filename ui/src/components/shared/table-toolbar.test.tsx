import { UsersIcon } from "@hugeicons/core-free-icons";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { StatusTabs } from "./table-toolbar";

describe("StatusTabs", () => {
  it("draws a tab's icon before its label from sm up, kept out of its name", () => {
    renderWithProviders(
      <StatusTabs
        label="Status"
        loading={false}
        onValueChange={() => {}}
        tabs={[
          { value: "all", label: "All", count: 3, icon: UsersIcon },
          { value: "none", label: "Plain" },
        ]}
        value="all"
      />,
    );
    const all = screen.getByRole("tab", { name: /^All/ });
    const icon = all.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("max-sm:hidden");
    expect(all.firstElementChild).toBe(icon);
    expect(screen.getByRole("tab", { name: "Plain" }).querySelector("svg")).toBeNull();
  });
});
