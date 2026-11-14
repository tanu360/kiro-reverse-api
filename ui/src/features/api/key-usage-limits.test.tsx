import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiKey } from "@/lib/api/types";
import { renderWithProviders } from "@/test/render";
import { KeyLimitsCard } from "./key-usage-limits";

const base: ApiKey = {
  id: "k1",
  keyMasked: "sk-k1****0001",
  enabled: true,
  createdAt: 1_790_000_000,
  tokensUsed: 9_999_998,
  creditsUsed: 150,
  requestsCount: 12,
  successfulCalls: 7,
};

function row(name: string): HTMLElement {
  const label = screen.getByText(name, { selector: "span" });
  const item = label.closest("li");
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

describe("KeyLimitsCard", () => {
  it("shows each capped limit's share and what is left, and flags a spent one", () => {
    renderWithProviders(
      <KeyLimitsCard apiKey={{ ...base, tokenLimit: 10_000_000, creditLimit: 150 }} />,
    );
    const tokens = row("Tokens");
    // Not yet spent, so never rounded up to 100 %.
    expect(within(tokens).getByText("99.9%")).toBeInTheDocument();
    expect(within(tokens).getByText("2 left")).toBeInTheDocument();
    expect(within(tokens).getByRole("meter")).toHaveAccessibleName(
      "Tokens used: 9,999,998 of 10,000,000",
    );
    const credits = row("Credits");
    expect(within(credits).getByText("100.0%")).toBeInTheDocument();
    expect(within(credits).getByText("Limit reached")).toBeInTheDocument();
    const calls = row("Calls");
    expect(within(calls).getByText("Unlimited")).toBeInTheDocument();
    expect(within(calls).getByText("7 used")).toBeInTheDocument();
    expect(within(calls).queryByRole("meter")).toBeNull();
  });
});
