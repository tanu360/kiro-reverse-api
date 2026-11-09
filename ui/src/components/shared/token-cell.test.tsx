import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { TokenCell } from "./token-cell";

describe("TokenCell", () => {
  it("is not a tab stop, so a table row stays one Tab stop", async () => {
    const { user } = renderWithProviders(
      <>
        <button type="button">Before</button>
        <TokenCell cacheReadTokens={9900} inTokens={14500} outTokens={688} />
        <button type="button">After</button>
      </>,
    );
    screen.getByRole("button", { name: "Before" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("shows the total over input → output and the cached count, never wrapping", () => {
    renderWithProviders(<TokenCell cacheReadTokens={9900} inTokens={14500} outTokens={688} />);
    const total = screen.getByText("15.2K");
    expect(total).toHaveClass("font-medium");
    const flow = screen.getByText("14.5K").parentElement;
    if (!flow) throw new Error("no token line");
    expect(flow.className).toContain("whitespace-nowrap");
    // Screen readers hear the labels the arrow and the database mark stand for.
    expect(flow.textContent).toBe("In14.5KOut6889.9K cached9.9K");
    expect(screen.getByText("9.9K cached")).toHaveClass("sr-only");
    expect(screen.getByText("9.9K")).toHaveClass("truncate");
    // No width cap or floor of its own: a narrow card column keeps it inside its border.
    const cell = total.parentElement;
    if (!cell) throw new Error("no token cell");
    expect(cell.className).not.toContain("min-w-48");
    expect(cell.className).not.toContain("max-w-60");
    expect(cell.className).toContain("tabular-nums");
  });

  it("shows the written count when the request only wrote to the cache", () => {
    renderWithProviders(<TokenCell cacheWriteTokens={5000} inTokens={39400} outTokens={2200} />);
    expect(screen.getByText("5K to cache")).toHaveClass("sr-only");
    expect(screen.getByText("5K")).toBeInTheDocument();
  });

  it("leaves out the cache mark when the request used no cache", () => {
    renderWithProviders(<TokenCell inTokens={1200} outTokens={300} />);
    expect(screen.getByText("1.2K")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.queryByText(/cache/)).not.toBeInTheDocument();
  });

  it("takes a width floor for a table column", () => {
    renderWithProviders(<TokenCell detailClassName="min-w-48" inTokens={1} outTokens={2} />);
    expect(screen.getByText("3").closest(".min-w-48")).not.toBeNull();
  });

  it("shows a muted dash for a failed request that used nothing", () => {
    renderWithProviders(<TokenCell inTokens={0} muteZero outTokens={0} />);
    const dash = screen.getByText("—");
    expect(dash).toHaveClass("text-muted-foreground");
    expect(screen.queryByText("In")).not.toBeInTheDocument();
  });

  it("shows 0 without muteZero", () => {
    renderWithProviders(<TokenCell inTokens={0} outTokens={0} />);
    // The total, then 0 → 0.
    expect(screen.getAllByText("0")).toHaveLength(3);
    expect(screen.getAllByText("0")[0]).toHaveClass("font-medium");
  });
});
