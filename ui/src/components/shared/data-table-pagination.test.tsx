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
    const current = screen.getByRole("button", { name: "Page 5" });
    expect(current).toHaveAttribute("aria-current", "page");
    // The current page is the bold one; the others keep the regular weight and no fill.
    expect(current).toHaveClass("font-semibold");
    expect(current).not.toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: "Page 4" })).not.toHaveClass("font-semibold");
    expect(screen.queryByRole("button", { name: "Page 2" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Page 10" }));
    expect(onPageChange).toHaveBeenCalledWith(10);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenLastCalledWith(6);
  });

  it("disables navigation for an empty list", () => {
    renderWithProviders(
      <DataTablePagination page={1} pageSize={25} total={0} onPageChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the page size as a Rows select only when the caller can change it", () => {
    const { unmount } = renderWithProviders(
      <DataTablePagination page={1} pageSize={25} total={100} onPageChange={vi.fn()} />,
    );
    expect(screen.queryByText("Rows")).not.toBeInTheDocument();
    unmount();

    renderWithProviders(
      <DataTablePagination
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        page={1}
        pageSize={25}
        pageSizeOptions={[10, 25, 50]}
        total={100}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Rows" })).toHaveTextContent("25");
  });
});
