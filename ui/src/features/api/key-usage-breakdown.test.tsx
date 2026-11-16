import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiKeyUsageBreakdownItem } from "@/lib/api/api-key-usage";
import { renderWithProviders } from "@/test/render";
import { UsageBreakdownCard } from "./key-usage-breakdown";

function item(id: string, requests: number, credits = 0): ApiKeyUsageBreakdownItem {
  return { id, requests, succeeded: requests, failed: 0, tokens: requests * 100, credits };
}

const MODELS = [item("claude-sonnet-5", 9, 1.2), item("claude-haiku-4.5", 3, 0.2)];

/** The name cell of each body row, top to bottom. */
function names(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent ?? "");
}

describe("UsageBreakdownCard by client", () => {
  it("switches the key holder's card between models and who called, its title following", async () => {
    const { user } = renderWithProviders(
      <UsageBreakdownCard
        clients={[
          // "other" leads by requests, yet ranks after the callers it can name.
          item("other", 12),
          item("claude-code", 7, 0.8),
          item("claude", 4, 0.5),
          item("responses", 2, 0.1),
        ]}
        loading={false}
        models={MODELS}
        showAccounts={false}
        showClients
        title="Usage by model"
      />,
    );
    expect(screen.getByRole("heading", { name: "Usage by model" })).toBeInTheDocument();
    const radios = within(screen.getByRole("radiogroup", { name: "Breakdown" })).getAllByRole(
      "radio",
    );
    expect(radios.map((radio) => radio.textContent)).toEqual(["By model", "By client"]);
    expect(screen.queryByRole("radio", { name: "Accounts" })).toBeNull();
    expect(names(screen.getByRole("table", { name: "Models" }))).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4.5",
    ]);

    await user.click(screen.getByRole("radio", { name: "By client" }));
    expect(screen.getByRole("heading", { name: "Usage by client" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Usage by client" });
    expect(within(table).getByRole("columnheader", { name: "Client" })).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Requests by client" })).toBeInTheDocument();
    // The Requests table's names and marks: the tool, else the API by company; "Other" last,
    // without a mark.
    expect(names(table)).toEqual(["Claude Code", "Anthropic API", "OpenAI Responses", "Other"]);
    const rows = within(table).getAllByRole("row").slice(1);
    for (const row of rows.slice(0, 3)) {
      expect(row.querySelector("[data-slot=request-caller] svg")).not.toBeNull();
    }
    expect(rows[3].querySelector("[data-slot=request-caller]")).toBeNull();
    expect(rows[0]).toHaveTextContent("0.80");

    await user.click(screen.getByRole("radio", { name: "By model" }));
    expect(screen.getByRole("heading", { name: "Usage by model" })).toBeInTheDocument();
  });

  it("folds Other into the ring's rest once more than five callers called", async () => {
    const { user } = renderWithProviders(
      <UsageBreakdownCard
        clients={[
          item("other", 40),
          item("claude-code", 30),
          item("codex", 20),
          item("claude", 10),
          item("openai", 8),
          item("opencode", 6),
          item("cline", 1),
        ]}
        loading={false}
        models={MODELS}
        showAccounts={false}
        showClients
        title="Usage by model"
      />,
    );
    await user.click(screen.getByRole("radio", { name: "By client" }));
    const table = screen.getByRole("table", { name: "Usage by client" });
    expect(names(table)).toEqual([
      "Claude Code",
      "Codex",
      "Anthropic API",
      "OpenAI API",
      "opencode",
    ]);
    expect(screen.getByText("2 more clients")).toBeInTheDocument();
  });

  it("counts nothing more when Other takes a sixth row beside five callers", async () => {
    const { user } = renderWithProviders(
      <UsageBreakdownCard
        clients={[
          item("other", 40),
          item("claude-code", 30),
          item("codex", 20),
          item("claude", 10),
          item("openai", 8),
          item("opencode", 6),
        ]}
        loading={false}
        models={MODELS}
        showAccounts={false}
        showClients
        title="Usage by model"
      />,
    );
    await user.click(screen.getByRole("radio", { name: "By client" }));
    const table = screen.getByRole("table", { name: "Usage by client" });
    expect(names(table)).toEqual([
      "Claude Code",
      "Codex",
      "Anthropic API",
      "OpenAI API",
      "opencode",
      "Other",
    ]);
    expect(screen.queryByText(/more client/)).toBeNull();
  });

  it.each([
    ["loads until the clients come", undefined, true],
    ["says so when the range has no traffic", [], false],
  ] as const)("%s", async (_, clients, loading) => {
    const { user } = renderWithProviders(
      <UsageBreakdownCard
        clients={clients}
        loading={loading}
        models={MODELS}
        showAccounts={false}
        showClients
        title="Usage by model"
      />,
    );
    await user.click(screen.getByRole("radio", { name: "By client" }));
    expect(screen.getByRole("heading", { name: "Usage by client" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    if (clients) expect(screen.getByText("No usage in this range")).toBeInTheDocument();
    else expect(screen.queryByText("No usage in this range")).toBeNull();
  });

  it("keeps the admin's Models / Accounts switch and title", () => {
    renderWithProviders(
      <UsageBreakdownCard
        accounts={[item("acc-1", 2)]}
        clients={[item("claude-code", 2)]}
        loading={false}
        models={MODELS}
      />,
    );
    expect(screen.getByRole("heading", { name: "Breakdown" })).toBeInTheDocument();
    const radios = within(screen.getByRole("radiogroup", { name: "Breakdown" })).getAllByRole(
      "radio",
    );
    expect(radios.map((radio) => radio.textContent)).toEqual(["Models", "Accounts"]);
    expect(screen.queryByRole("radio", { name: "By client" })).toBeNull();
  });
});
