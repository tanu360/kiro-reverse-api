import { UsersIcon } from "@hugeicons/core-free-icons";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { FilterBar, PageSizeSelect, StatusTabs } from "./table-toolbar";

// The filter bar's measured width; jsdom lays nothing out.
const barWidth = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/hooks/use-element-width", () => ({ useElementWidth: () => barWidth.value }));

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

describe("FilterBar", () => {
  function renderBar(width: number) {
    barWidth.value = width;
    return renderWithProviders(
      <FilterBar
        end={<span>3 of 9</span>}
        pageSize={<PageSizeSelect onChange={() => {}} options={[10, 25]} value={25} />}
        search={<input aria-label="Search" />}
      >
        <button type="button">Plan</button>
      </FilterBar>,
    );
  }

  it("scrolls the controls and the count on one line, never the search or Rows", () => {
    const { container } = renderBar(1200);
    const line = container.querySelector("[data-slot=scroll-area-viewport]");
    expect(line).toContainElement(screen.getByRole("button", { name: "Plan" }));
    expect(line).toContainElement(screen.getByText("3 of 9"));
    expect(line).not.toContainElement(screen.getByRole("textbox", { name: "Search" }));
    expect(line).not.toContainElement(screen.getByRole("button", { name: "Rows: 25" }));
    // From 64rem Rows keeps its label.
    expect(screen.getByText("Rows")).toBeInTheDocument();
  });

  it("drops the Rows label in a narrow bar, its name still saying Rows", () => {
    renderBar(600);
    expect(screen.getByRole("button", { name: "Rows: 25" })).toHaveTextContent(/^25$/);
    expect(screen.queryByText("Rows")).not.toBeInTheDocument();
  });
});
