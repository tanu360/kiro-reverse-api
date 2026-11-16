import { UsersIcon } from "@hugeicons/core-free-icons";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { FilterBar, PageSizeSelect, StatusTabs } from "./table-toolbar";

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
  function renderBar() {
    return renderWithProviders(
      <FilterBar
        end={
          <>
            <button type="button">Clear</button>
            <span>3 of 9</span>
          </>
        }
        pageSize={<PageSizeSelect onChange={() => {}} options={[10, 25]} value={25} />}
        search={<input aria-label="Search" />}
      >
        <button type="button">Plan</button>
      </FilterBar>,
    );
  }

  it("scrolls only the controls: the search, Clear, the count and Rows stay in view", () => {
    const { container } = renderBar();
    const line = container.querySelector("[data-slot=scroll-area-viewport]");
    expect(line).toContainElement(screen.getByRole("button", { name: "Plan" }));
    expect(line).not.toContainElement(screen.getByRole("button", { name: "Clear" }));
    expect(line).not.toContainElement(screen.getByText("3 of 9"));
    expect(line).not.toContainElement(screen.getByRole("textbox", { name: "Search" }));
    expect(line).not.toContainElement(screen.getByRole("button", { name: "Rows: 25" }));
  });

  it("drops the Rows label below a 64rem bar by container query, its name still saying Rows", () => {
    renderBar();
    // jsdom runs no container queries: the class decides, so the first paint is already right.
    expect(screen.getByText("Rows")).toHaveClass("@max-5xl/filter-bar:hidden");
    const rows = screen.getByRole("button", { name: "Rows: 25" });
    expect(rows).toHaveTextContent(/^25$/);
    expect(rows).toHaveClass("@max-5xl/filter-bar:rounded-s-lg!");
  });
});
