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

  it("lets the breakdown line wrap instead of widening the column", () => {
    renderWithProviders(<TokenCell cacheReadTokens={9900} inTokens={14500} outTokens={688} />);
    const detail = screen.getByText(/^In 14\.5K · Out 688/);
    expect(detail.className).toContain("whitespace-normal");
    expect(detail.className).toContain("max-w-60");
    // A floor, so an auto-layout table cannot squeeze it to one word per line.
    expect(detail.className).toContain("min-w-48");
  });
});
