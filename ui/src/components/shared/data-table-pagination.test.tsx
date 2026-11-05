import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { DataTablePagination } from "./data-table-pagination";

describe("table pagination", () => {
  it("jumps to numbered pages and marks the current page", async () => {
    const onPageChange = vi.fn();
    const { user } = renderWithProviders(
      <DataTablePagination page={5} pageSize={25} total={250} onPageChange={onPageChange} />,
    );
    expect(screen.getByRole("button", { name: "Previous" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Next" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "5" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "10" }));
    expect(onPageChange).toHaveBeenCalledWith(10);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenLastCalledWith(6);
  });

  it("disables navigation for an empty list", () => {
    renderWithProviders(
      <DataTablePagination
        variant="circle"
        page={1}
        pageSize={25}
        total={0}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1" })).toHaveAttribute("aria-current", "page");
  });
});
