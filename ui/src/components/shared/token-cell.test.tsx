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

  it("shows the total with in/out on one line and the cache on a second, never wrapping", () => {
    renderWithProviders(<TokenCell cacheReadTokens={9900} inTokens={14500} outTokens={688} />);
    const inOut = screen.getByText("In 14.5K · Out 688");
    expect(inOut.className).toContain("whitespace-nowrap");
    expect(inOut.parentElement?.textContent).toBe("15.2KIn 14.5K · Out 688");
    const cache = screen.getByText("Cache read 9.9K, write 0");
    expect(cache.className).toContain("truncate");
    expect(cache.className).toContain("whitespace-nowrap");
    // No width cap or floor of its own: a narrow card column keeps it inside its border.
    const cell = cache.parentElement;
    if (!cell) throw new Error("no token cell");
    expect(cell.className).not.toContain("min-w-48");
    expect(cell.className).not.toContain("max-w-60");
    expect(cell.className).toContain("tabular-nums");
  });

  it("leaves out the cache line when the request used no cache", () => {
    renderWithProviders(<TokenCell inTokens={1200} outTokens={300} />);
    expect(screen.getByText("In 1.2K · Out 300")).toBeInTheDocument();
    expect(screen.queryByText(/Cache read/)).not.toBeInTheDocument();
  });

  it("takes a width floor for a table column", () => {
    renderWithProviders(<TokenCell detailClassName="min-w-48" inTokens={1} outTokens={2} />);
    expect(screen.getByText("In 1 · Out 2").closest(".min-w-48")).not.toBeNull();
  });

  it("shows a muted dash for a failed request that used nothing", () => {
    renderWithProviders(<TokenCell inTokens={0} muteZero outTokens={0} />);
    const dash = screen.getByText("—");
    expect(dash).toHaveClass("text-muted-foreground");
    expect(screen.queryByText(/In 0/)).not.toBeInTheDocument();
  });

  it("shows 0 without muteZero", () => {
    renderWithProviders(<TokenCell inTokens={0} outTokens={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
