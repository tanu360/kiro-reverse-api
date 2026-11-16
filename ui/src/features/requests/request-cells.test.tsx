import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import { renderWithProviders } from "@/test/render";
import {
  CreditsChip,
  DurationChip,
  ErrorPill,
  StatusNode,
  speedTone,
  TokenUsage,
  whenText,
} from "./request-cells";
import { CallerLabel, requestCaller } from "./request-client";
import { RequestCard, useRequestColumns } from "./requests-columns";

const NOW = 1_763_300_000;

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    ts: NOW,
    accountId: "acc-1",
    email: "owner@example.com",
    apiKeyMasked: "sk-abc1****wxyz",
    model: "claude-sonnet-5",
    inTokens: 12_000,
    outTokens: 1_600,
    totalTokens: 13_600,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 0,
    credits: 0.15,
    success: true,
    status: 200,
    endpoint: "claude",
    durationMs: 1_840,
    ...overrides,
  };
}

const FAILED = record({
  success: false,
  status: 429,
  errorType: "rate_limit",
  message: "ThrottlingException: Too many requests",
  inTokens: 0,
  outTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  credits: 0,
  durationMs: 412,
});

describe("the caller line", () => {
  it.each([
    [{ client: "claude-code", endpoint: "claude" }, "Claude Code"],
    [{ client: "codex", endpoint: "responses" }, "Codex"],
    [{ client: "opencode", endpoint: "openai" }, "opencode"],
    [{ client: "cline", endpoint: "openai" }, "Cline"],
    [{ client: "roo-code", endpoint: "openai" }, "Roo Code"],
    [{ client: "kilo-code", endpoint: "claude" }, "Kilo Code"],
    // No tool the server knew: the client API instead, as variant 5 named it.
    [{ endpoint: "claude" }, "Claude API"],
    [{ endpoint: "openai" }, "OpenAI Chat"],
    [{ endpoint: "responses" }, "Responses"],
    // An id from a newer server reads as no tool.
    [{ client: "zed", endpoint: "claude" }, "Claude API"],
  ] as const)("names %o as %s, with its mark", (fields, name) => {
    const { container } = renderWithProviders(<CallerLabel record={fields} />);
    expect(screen.getByText(name)).toBeInTheDocument();
    const mark = container.querySelector("svg");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("draws Clawd, Claude Code's orange crab, for Claude Code", () => {
    const { container } = renderWithProviders(
      <CallerLabel record={{ client: "claude-code", endpoint: "claude" }} />,
    );
    expect(container.querySelector("path")).toHaveAttribute("fill", "#D97757");
  });

  it("names nothing for a row with neither a client nor an endpoint", () => {
    expect(requestCaller({})).toBeNull();
    const { container } = renderWithProviders(<CallerLabel record={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the status node", () => {
  it("says the status in words, with a failure's HTTP status", () => {
    renderWithProviders(
      <>
        <StatusNode record={record()} />
        <StatusNode record={FAILED} />
        <StatusNode record={{ ...FAILED, status: undefined }} />
      </>,
    );
    expect(screen.getByText("Succeeded")).toHaveClass("sr-only");
    expect(screen.getByText("Failed 429")).toHaveClass("sr-only");
    expect(screen.getByText("Failed")).toHaveClass("sr-only");
  });
});

describe("the time lines", () => {
  it("shows the clock time today and the date for older rows", () => {
    const now = new Date(2026, 10, 16, 15, 0);
    const today = new Date(2026, 10, 16, 9, 5).getTime() / 1000;
    const yesterday = new Date(2026, 10, 15, 23, 50).getTime() / 1000;
    expect(whenText(today, "en", now)).toBe("9:05 AM");
    expect(whenText(yesterday, "en", now)).toBe("Nov 15");
  });
});

describe("the token usage", () => {
  it("shows the total, the stacked bar and all four counts, cache counts of zero too", async () => {
    const { container, user } = renderWithProviders(<TokenUsage record={record()} />);
    expect(screen.getByText("13.6K")).toHaveClass("font-medium", { exact: false });
    const figures = container.querySelector("[data-slot=token-figures]");
    expect(figures?.textContent).toBe("In12KOut1.6KCache read5KCache write0");
    for (const label of ["In", "Out", "Cache read", "Cache write"]) {
      expect(within(figures as HTMLElement).getByText(label)).toHaveClass("sr-only");
    }
    // Input not from the cache, the cache read and the output, each by its count.
    const parts = [...container.querySelectorAll("[data-part]")].map((part) => [
      part.getAttribute("data-part"),
      (part as HTMLElement).style.flexGrow,
    ]);
    expect(parts).toEqual([
      ["input", "7000"],
      ["cacheRead", "5000"],
      ["output", "1600"],
    ]);
    // The tooltip keeps every count in full, as the column always has.
    await user.hover(container.querySelector("[data-slot=token-usage]") as HTMLElement);
    expect(await screen.findByText("12,000")).toBeInTheDocument();
    const tooltip = document.querySelector("[data-slot=tooltip-popup]");
    expect(tooltip?.textContent).toBe("In12,000Out1,600Cache read5,000Cache write0Total13,600");
  });

  it("caps the cache read at the input and leaves out an empty part", () => {
    const { container } = renderWithProviders(
      <TokenUsage record={record({ inTokens: 100, outTokens: 0, cacheReadTokens: 400 })} />,
    );
    const parts = [...container.querySelectorAll("[data-part]")].map((part) =>
      part.getAttribute("data-part"),
    );
    expect(parts).toEqual(["cacheRead"]);
  });

  it("is a dash for a failure that used no tokens, but counts a cut stream", () => {
    const { container, rerender } = renderWithProviders(<TokenUsage record={FAILED} />);
    expect(container).toHaveTextContent(/^—$/);
    rerender(
      <TokenUsage record={{ ...FAILED, errorType: "stream", inTokens: 900, outTokens: 40 }} />,
    );
    expect(container.querySelector("[data-slot=token-bar]")).not.toBeNull();
  });
});

describe("the figure chips", () => {
  it.each([
    [900, "fast", "success"],
    [2_999, "fast", "success"],
    [3_000, "normal", "neutral"],
    [19_999, "normal", "neutral"],
    [20_000, "slow", "warning"],
    [89_999, "slow", "warning"],
    [90_000, "crawl", "destructive"],
  ] as const)("tints a %i ms duration %s", (durationMs, speed, tone) => {
    expect(speedTone(durationMs)).toBe(speed);
    const { container } = renderWithProviders(<DurationChip record={record({ durationMs })} />);
    expect(container.querySelector("[data-speed]")).toHaveAttribute("data-speed", speed);
    expect(container.querySelector("[data-slot=figure-chip]")).toHaveAttribute("data-tone", tone);
    expect(screen.getByText("Duration")).toHaveClass("sr-only");
  });

  it("shows a dash for a row logged before durations were", () => {
    const { container } = renderWithProviders(
      <DurationChip record={record({ endpoint: undefined, durationMs: undefined })} />,
    );
    expect(container).toHaveTextContent(/^—$/);
  });

  it("puts the credits on the brand chip, and a dash for a failure that cost nothing", () => {
    const { container, rerender } = renderWithProviders(<CreditsChip record={record()} />);
    expect(container.querySelector("[data-slot=figure-chip]")).toHaveAttribute(
      "data-tone",
      "primary",
    );
    expect(container).toHaveTextContent("Credits0.15");
    rerender(<CreditsChip record={FAILED} />);
    expect(container).toHaveTextContent(/^—$/);
  });
});

describe("the error pill", () => {
  it.each([
    ["rate_limit", 429, "Rate limited · 429", "warning"],
    ["auth", 401, "Authentication · 401", "destructive"],
    ["client_closed", 499, "Client disconnected · 499", "muted"],
    ["brand_new_type", 500, "brand_new_type · 500", "destructive"],
  ] as const)("labels %s in its tier's colour", (errorType, status, text, tone) => {
    renderWithProviders(
      <ErrorPill
        record={{ ...FAILED, errorType: errorType as RequestRecord["errorType"], status }}
      />,
    );
    expect(screen.getByText(text)).toHaveAttribute("data-tone", tone);
  });
});

describe("RequestCard", () => {
  it("shows the account and the message on the admin's list", () => {
    const { container } = renderWithProviders(
      <RequestCard record={{ ...FAILED, client: "claude-code" }} />,
    );
    // Masked: tests run with privacy mode on.
    expect(container).toHaveTextContent("ow***@ex***.com");
    expect(screen.getByText("ThrottlingException: Too many requests")).toBeInTheDocument();
    expect(screen.getByText("Rate limited · 429")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Failed 429")).toHaveClass("sr-only");
  });

  it("leaves out the account and the message for a key holder", () => {
    renderWithProviders(
      <RequestCard accounts={false} messages={false} record={{ ...FAILED, client: "codex" }} />,
    );
    expect(document.body).not.toHaveTextContent("ow***@ex***.com");
    expect(screen.queryByText("ThrottlingException: Too many requests")).not.toBeInTheDocument();
    expect(screen.getByText("Rate limited · 429")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("puts the token bar beside the credits and duration chips on a success", () => {
    const { container } = renderWithProviders(<RequestCard record={record()} />);
    expect(container.querySelector("[data-slot=token-bar]")).not.toBeNull();
    expect(container.querySelectorAll("[data-slot=figure-chip]")).toHaveLength(2);
    expect(container.querySelector("[data-slot=token-figures]")?.textContent).toBe(
      "In12KOut1.6KCache read5KCache write0",
    );
  });
});

function ColumnIds({ accounts }: { accounts: boolean }) {
  const columns = useRequestColumns({ accounts });
  return <output>{columns.map((column) => column.id).join(" ")}</output>;
}

describe("useRequestColumns", () => {
  it("has no Status or Endpoint column, and drops Account and API key for a key holder", () => {
    const { rerender } = renderWithProviders(<ColumnIds accounts />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "time model account api_key tokens credits duration error",
    );
    rerender(<ColumnIds accounts={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "time model tokens credits duration error",
    );
  });
});
