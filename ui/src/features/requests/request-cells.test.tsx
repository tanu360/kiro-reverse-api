import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { renderWithProviders } from "@/test/render";
import {
  CacheHit,
  CreditsChip,
  cacheHitShare,
  DurationChip,
  ErrorPill,
  HttpStatus,
  outputSpeed,
  outputSpeedTone,
  RequestIdCopy,
  SpeedChip,
  StatusNode,
  shortRequestId,
  speedTone,
  TokenUsage,
  whenText,
} from "./request-cells";
import { CallerLabel, requestCaller } from "./request-client";
import { requestTries } from "./request-model";
import { RequestCard, useRequestColumns } from "./requests-columns";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(() => Promise.resolve(true)) }));

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
    // No tool the server knew: the company behind the API instead.
    [{ endpoint: "claude" }, "Anthropic API"],
    [{ endpoint: "openai" }, "OpenAI API"],
    [{ endpoint: "responses" }, "OpenAI Responses"],
    // An id from a newer server reads as no tool.
    [{ client: "zed", endpoint: "claude" }, "Anthropic API"],
  ] as const)("names %o as %s, with its mark", (fields, name) => {
    const { container } = renderWithProviders(<CallerLabel record={fields} />);
    expect(screen.getByText(name)).toBeInTheDocument();
    const mark = container.querySelector("svg");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("marks both of OpenAI's APIs with the OpenAI mark, not Codex's", () => {
    const mark = (record: Parameters<typeof CallerLabel>[0]["record"]) =>
      renderWithProviders(<CallerLabel record={record} />).container.querySelector("svg")
        ?.innerHTML;
    const openai = mark({ endpoint: "openai" });
    expect(mark({ endpoint: "responses" })).toBe(openai);
    expect(mark({ client: "codex", endpoint: "responses" })).not.toBe(openai);
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

describe("the duration and credits", () => {
  it.each([
    [900, "fast", "900ms", "text-muted-foreground"],
    [2_999, "fast", "3.00s", "text-muted-foreground"],
    [3_000, "normal", "3.00s", "text-muted-foreground"],
    [19_999, "normal", "20.0s", "text-muted-foreground"],
    [20_000, "slow", "20.0s", "text-muted-foreground"],
    [89_999, "slow", "1m 30s", "text-muted-foreground"],
    [90_000, "crawl", "1m 30s", "text-muted-foreground"],
  ] as const)("marks a %i ms duration %s, always muted", (durationMs, speed, text, tone) => {
    expect(speedTone(durationMs)).toBe(speed);
    const { container } = renderWithProviders(<DurationChip record={record({ durationMs })} />);
    const duration = container.querySelector("[data-speed]");
    expect(duration).toHaveAttribute("data-speed", speed);
    expect(duration).toHaveClass(tone);
    expect(container).toHaveTextContent(new RegExp(`^${text}$`));
    // No chip, no mark and no screen-reader label: the column header names it.
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByText("Duration")).not.toBeInTheDocument();
  });

  it("shows the exact milliseconds on hover", async () => {
    const { container, user } = renderWithProviders(
      <DurationChip record={record({ durationMs: 89_999 })} />,
    );
    await user.hover(container.querySelector("[data-speed]") as HTMLElement);
    expect(await screen.findByText("89,999 ms")).toBeInTheDocument();
  });

  it("shows a dash for a row logged before durations were", () => {
    const { container } = renderWithProviders(
      <DurationChip record={record({ endpoint: undefined, durationMs: undefined })} />,
    );
    expect(container).toHaveTextContent(/^—$/);
  });

  it("shows the credits in semibold with a muted cr, and a dash for a failure that cost nothing", () => {
    const { container, rerender } = renderWithProviders(<CreditsChip record={record()} />);
    expect(container).toHaveTextContent(/^0\.15cr$/);
    expect(screen.getByText("0.15")).toHaveClass("font-semibold");
    expect(screen.getByText("cr")).toHaveClass("text-muted-foreground");
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByText("Credits")).not.toBeInTheDocument();
    rerender(<CreditsChip record={FAILED} />);
    expect(container).toHaveTextContent(/^—$/);
    // A failure that still cost something shows it.
    rerender(<CreditsChip record={{ ...FAILED, credits: 0.04 }} />);
    expect(container).toHaveTextContent(/^0\.04cr$/);
  });

  it("shows the exact credits on hover", async () => {
    const { user } = renderWithProviders(<CreditsChip record={record({ credits: 0.0567891 })} />);
    await user.hover(screen.getByText("0.06"));
    expect(await screen.findByText("0.0567891 cr")).toBeInTheDocument();
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

describe("the speed", () => {
  it.each([
    // 1,600 output tokens over the whole request.
    [8_000, "200 tok/s", "fast", "text-muted-foreground"],
    [20_000, "80 tok/s", "fast", "text-muted-foreground"],
    [32_000, "50 tok/s", "normal", "text-muted-foreground"],
    [80_000, "20 tok/s", "normal", "text-muted-foreground"],
    [200_000, "8.0 tok/s", "slow", "text-muted-foreground"],
  ] as const)("reads 1.6K tokens over %i ms as %s (%s)", (durationMs, text, speed, tone) => {
    const { container } = renderWithProviders(<SpeedChip record={record({ durationMs })} />);
    const figure = container.querySelector("[data-output-speed]");
    expect(figure).toHaveAttribute("data-output-speed", speed);
    expect(figure).toHaveClass(tone);
    expect(container).toHaveTextContent(new RegExp(`^${text}$`));
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByText("Speed")).not.toBeInTheDocument();
  });

  it("puts the slow and fast lines at 20 and 80 tok/s", () => {
    expect(outputSpeedTone(19.9)).toBe("slow");
    expect(outputSpeedTone(20)).toBe("normal");
    expect(outputSpeedTone(79.9)).toBe("normal");
    expect(outputSpeedTone(80)).toBe("fast");
  });

  it("never reads 0 for a trickle", () => {
    const { container } = renderWithProviders(
      <SpeedChip record={record({ outTokens: 1, durationMs: 60_000 })} />,
    );
    expect(container).toHaveTextContent(/^<0\.1 tok\/s$/);
  });

  it.each([
    ["a failure", { success: false, status: 502, errorType: "stream" as const }],
    ["no output", { outTokens: 0 }],
    ["no duration", { durationMs: 0 }],
    ["a row logged before durations", { durationMs: undefined, endpoint: undefined }],
  ])("is a dash for %s", (_, patch) => {
    expect(outputSpeed(record(patch))).toBeUndefined();
    const { container } = renderWithProviders(<SpeedChip record={record(patch)} />);
    expect(container).toHaveTextContent(/^—$/);
  });
});

describe("the cache hit", () => {
  it("is the cache read's share of the input, which already holds it", () => {
    // 5K of the 12K input came from the cache: 42%, not 5K of 17K.
    expect(cacheHitShare(record())).toBeCloseTo(5_000 / 12_000);
    const { container } = renderWithProviders(<CacheHit record={record()} />);
    expect(container).toHaveTextContent("Cache hit42%");
    expect(screen.getByText("Cache hit")).toHaveClass("sr-only");
    const meter = container.querySelector("[role=meter]");
    expect(meter).toHaveAttribute("aria-valuenow", String(5_000 / 12_000));
    expect(meter?.closest("[aria-hidden=true]")).not.toBeNull();
  });

  it.each([
    [0, "0%"],
    [6, "<1%"],
    [12_000, "100%"],
    // A cache read over the input (never sent; the server caps it) still reads 100%.
    [20_000, "100%"],
  ])("reads %i cached of 12K input as %s", (cacheReadTokens, text) => {
    const { container } = renderWithProviders(<CacheHit record={record({ cacheReadTokens })} />);
    expect(container).toHaveTextContent(`Cache hit${text}`);
  });

  it("names itself on a narrow row, and is a dash without input", () => {
    const { container, rerender } = renderWithProviders(<CacheHit labelled record={record()} />);
    expect(screen.getByText("Cache hit")).not.toHaveClass("sr-only");
    rerender(<CacheHit record={FAILED} />);
    expect(cacheHitShare(FAILED)).toBeUndefined();
    expect(container).toHaveTextContent(/^—$/);
  });
});

describe("the HTTP status and tries", () => {
  it("shows a success's status on a neutral pill over one try", () => {
    const { container } = renderWithProviders(<HttpStatus record={record({ tries: 1 })} />);
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "neutral");
    expect(container).toHaveTextContent("HTTP 2001 try");
    expect(screen.getByText("HTTP")).toHaveClass("sr-only");
    expect(screen.getByText("1 try")).toHaveClass("text-muted-foreground");
  });

  it("tints a failure's status as its error pill and brings out a retried request", () => {
    const { container } = renderWithProviders(<HttpStatus record={{ ...FAILED, tries: 4 }} />);
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("4 tries")).toHaveAttribute("data-tries", "4");
    expect(screen.getByText("4 tries")).toHaveClass("font-medium");
  });

  it("counts no tries for a request refused before any attempt", () => {
    const { container } = renderWithProviders(
      <HttpStatus record={{ ...FAILED, status: 401, errorType: "auth", tries: 0 }} />,
    );
    expect(container).toHaveTextContent(/^HTTP 401$/);
    expect(container.querySelector("[data-tries]")).toBeNull();
  });

  it("counts an admin row's chain with the attempts the cap dropped", () => {
    const attempt = { accountId: "acc-1", startMs: 0, durationMs: 10, success: false };
    expect(requestTries(record())).toBe(0);
    expect(requestTries(record({ tries: 2 }))).toBe(2);
    expect(
      requestTries(record({ attempts: [attempt, { ...attempt, success: true, skipped: 3 }] })),
    ).toBe(5);
  });
});

describe("the request ID", () => {
  it("shows the prefix and four hex digits, and copies the whole ID", async () => {
    const id = "req_2dc29f0e8b7a6c5d4e3f2a1b";
    expect(shortRequestId(id)).toBe("req_2dc2…");
    expect(shortRequestId("req_ab")).toBe("req_ab");
    const { container, user } = renderWithProviders(
      <RequestIdCopy record={record({ requestId: id })} />,
    );
    expect(container).toHaveTextContent("Request ID req_2dc2…");
    await user.click(screen.getByRole("button", { name: "Copy request ID" }));
    expect(await vi.mocked(copyText).mock.calls.at(-1)?.[0]).toBe(id);
  });

  it("is a dash on a row logged before request IDs", () => {
    const { container } = renderWithProviders(<RequestIdCopy record={record()} />);
    expect(container).toHaveTextContent(/^—$/);
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

  it("adds the speed, cache hit and request ID with the details, but no HTTP status", () => {
    const { container } = renderWithProviders(
      <RequestCard
        accounts={false}
        details
        messages={false}
        record={record({ requestId: "req_2dc29f0e8b7a6c5d4e3f2a1b", tries: 2 })}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy request ID" })).toBeInTheDocument();
    expect(container).toHaveTextContent("req_2dc2…");
    expect(container.querySelector("[data-slot=http-status]")).toBeNull();
    expect(container.querySelector("[data-output-speed]")).toHaveTextContent(/^870 tok\/s$/);
    expect(screen.getByText("Cache hit")).not.toHaveClass("sr-only");
  });

  it("keeps the status in a failure's pill with the details, and no speed", () => {
    const { container } = renderWithProviders(
      <RequestCard accounts={false} details messages={false} record={{ ...FAILED, tries: 3 }} />,
    );
    expect(screen.getByText("Rate limited · 429")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=http-status]")).toBeNull();
    expect(container.querySelector("[data-output-speed]")).toBeNull();
    expect(container.querySelector("[data-slot=cache-hit]")).toBeNull();
  });

  it("puts the token bar beside the credits and the duration on a success", () => {
    const { container } = renderWithProviders(<RequestCard record={record()} />);
    expect(container.querySelector("[data-slot=token-bar]")).not.toBeNull();
    expect(screen.getByText("0.15")).toHaveClass("font-semibold");
    expect(screen.getByText("cr")).toHaveClass("text-muted-foreground");
    expect(container.querySelector("[data-speed]")).toHaveAttribute("data-speed", "fast");
    expect(container.querySelector("[data-speed]")).toHaveTextContent(/^1\.84s$/);
    expect(container.querySelector("[data-slot=token-figures]")?.textContent).toBe(
      "In12KOut1.6KCache read5KCache write0",
    );
  });
});

function ColumnIds({ accounts, details }: { accounts: boolean; details?: boolean }) {
  const columns = useRequestColumns({ accounts, details });
  return (
    <output>
      {columns
        .map((column) => `${column.id}${column.className?.includes("px-2") ? "" : "*"}`)
        .join(" ")}
    </output>
  );
}

describe("useRequestColumns", () => {
  it("has no Status or Endpoint column, and drops Account and API key for a key holder", () => {
    // * marks the first and last cells, which keep the card's side padding.
    const { rerender } = renderWithProviders(<ColumnIds accounts />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "time* model account api_key tokens credits duration error*",
    );
    rerender(<ColumnIds accounts={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "time* model tokens credits duration error*",
    );
  });

  it("adds the key holder's detail columns, none sortable, with Request ID before Error", () => {
    renderWithProviders(<ColumnIds accounts={false} details />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "time* model tokens cache_hit credits duration speed request_id error*",
    );
  });
});
