import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApiKeyUsageTotals } from "@/lib/api/api-key-usage";
import type { UserKey, UserUsage, UserUsageRange } from "@/lib/api/user-panel";
import { renderWithProviders } from "@/test/render";
import { KeyFacts } from "./key-facts";
import { limitShare, pillValues, UsageKpis } from "./usage-kpis";

// The usage cards and the key facts strip against each state a key can be in: no limits, near
// a limit, over one, brand new, expired or expiring, limited to models, and each comparison
// with the stretch before the range.

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function key(patch: Partial<UserKey> = {}): UserKey {
  return {
    id: "key-1",
    name: "cards",
    keyMasked: "sk-abc****wxyz",
    enabled: true,
    expired: false,
    createdAt: NOW - 30 * DAY,
    lastUsedAt: NOW - 300,
    expiresAt: 0,
    tokenLimit: 0,
    tokensUsed: 0,
    creditLimit: 0,
    creditsUsed: 0,
    callLimit: 0,
    successfulCalls: 0,
    requestsCount: 0,
    rpmLimit: 0,
    allowedModels: [],
    keysRequired: true,
    ...patch,
  };
}

function totals(patch: Partial<ApiKeyUsageTotals> = {}): ApiKeyUsageTotals {
  const base = { requests: 0, succeeded: 0, failed: 0, inTokens: 0, outTokens: 0, credits: 0 };
  const merged = { ...base, ...patch };
  return {
    ...merged,
    succeeded: patch.succeeded ?? merged.requests - merged.failed,
    tokens: patch.tokens ?? merged.inTokens + merged.outTokens,
  };
}

/** A range whose newest bucket holds all of `now`; `previous` as the server sends it. */
function usage(
  now: ApiKeyUsageTotals,
  previous?: ApiKeyUsageTotals,
  range: UserUsageRange = "24h",
): UserUsage {
  const count = range === "7d" ? 7 : range === "30d" ? 30 : 24;
  const buckets = Array.from({ length: count }, (_, index) => NOW - (count - 1 - index) * 3600);
  const series = buckets.map((_, index) => (index === count - 1 ? now : totals()));
  return {
    range,
    bucket: range === "24h" ? "hour" : "day",
    bucketSeconds: range === "24h" ? 3600 : DAY,
    tzOffset: 0,
    from: buckets[0],
    to: NOW + 3600,
    nowUnix: NOW,
    buckets,
    totals: now,
    keys: [{ id: "key-1", kind: "key", totals: now, series }],
    ...(previous ? { previous } : {}),
  };
}

function renderCards(
  apiKey: UserKey | undefined,
  data: UserUsage | undefined,
  { range = data?.range ?? "24h", isError = false } = {},
) {
  return renderWithProviders(
    <UsageKpis
      apiKey={apiKey}
      entry={data?.keys[0]}
      isError={isError}
      range={range}
      usage={data}
    />,
  );
}

/** The KPI card headed `label`. */
function card(label: string): HTMLElement {
  const heading = screen.getByText(label, { selector: "span" });
  return heading.closest('[data-slot="kpi-card"]') as HTMLElement;
}

describe("limitShare", () => {
  it.each([
    [0, false, "0%"],
    [0.0004, false, "<0.1%"],
    [0.0605, false, "6.1%"],
    [0.169, false, "17%"],
    [0.9996, false, "99%"],
    [1, true, "100%"],
    [1.041, true, "104%"],
  ])("reads %f (reached %s) as %s", (share, reached, text) => {
    expect(limitShare(share, reached, "en")).toBe(text);
  });
});

describe("pillValues", () => {
  it("keeps up to 24 buckets and sums longer series in runs, newest last", () => {
    expect(pillValues([1, 2, 3])).toEqual([1, 2, 3]);
    const month = Array.from({ length: 30 }, (_, index) => index);
    const pills = pillValues(month);
    expect(pills).toHaveLength(15);
    expect(pills.at(-1)).toBe(28 + 29);
    expect(pills.reduce((sum, value) => sum + value, 0)).toBe(435);
    // 50 in runs of 3 from the newest: the oldest pill holds the two left over.
    const long = pillValues(Array.from({ length: 50 }, () => 1));
    expect(long).toHaveLength(17);
    expect(long[0]).toBe(2);
  });
});

describe("usage cards", () => {
  it("shows each figure with its change against the stretch before, coloured by which way is good", () => {
    renderCards(
      key(),
      usage(
        totals({ requests: 30, failed: 3, credits: 2, inTokens: 900, outTokens: 100 }),
        totals({ requests: 20, failed: 6, credits: 4, inTokens: 900, outTokens: 100 }),
      ),
    );
    const delta = (label: string) => card(label).querySelector('[data-slot="kpi-delta"]');
    expect(delta("Requests")).toHaveTextContent("+50% vs previous 24 hours");
    expect(delta("Requests")).toHaveAttribute("data-tone", "good");
    // Fewer failures is good news; fewer credits is not.
    expect(delta("Failed")).toHaveTextContent("−50% vs previous 24 hours");
    expect(delta("Failed")).toHaveAttribute("data-tone", "good");
    expect(delta("Credits")).toHaveAttribute("data-tone", "bad");
    expect(delta("Tokens")).toHaveTextContent("0% vs previous 24 hours");
    expect(delta("Tokens")).toHaveAttribute("data-tone", "neutral");
    expect(within(card("Failed")).getByText("10% failed")).toBeInTheDocument();
    expect(within(card("Failed")).getByText("27 succeeded")).toBeInTheDocument();
    expect(within(card("Failed")).getByText("90.0% success")).toBeInTheDocument();
    expect(within(card("Tokens")).getByText("900 in · 100 out")).toBeInTheDocument();
  });

  it.each([
    ["7d", "+100% vs previous 7 days"],
    ["30d", "+100% vs previous 30 days"],
  ] as const)("compares %s with the stretch of the same length", (range, text) => {
    renderCards(key(), usage(totals({ requests: 4 }), totals({ requests: 2 }), range));
    expect(within(card("Requests")).getByText(/vs previous/).parentElement).toHaveTextContent(text);
  });

  it("says when nothing came before, and when a measure was zero before", () => {
    const { unmount } = renderCards(key(), usage(totals({ requests: 5, failed: 2 }), totals()));
    expect(screen.getAllByText("No requests the 24 hours before")).toHaveLength(4);
    unmount();
    renderCards(
      key(),
      usage(totals({ requests: 5, failed: 2, credits: 1 }), totals({ requests: 3, credits: 0 })),
    );
    expect(within(card("Failed")).getByText("None the 24 hours before")).toBeInTheDocument();
    expect(within(card("Credits")).getByText("None the 24 hours before")).toBeInTheDocument();
    expect(within(card("Requests")).getByText(/vs previous 24 hours/)).toBeInTheDocument();
  });

  it("reads a brand-new key as no requests yet, with flat trends and nothing failed", () => {
    renderCards(key({ lastUsedAt: 0 }), usage(totals(), totals()));
    expect(screen.getAllByText("No requests yet")).toHaveLength(3);
    expect(within(card("Failed")).getByText("Nothing failed")).toBeInTheDocument();
    // Every card's trend, Failed included, is the same empty track saying so.
    expect(screen.getAllByText("No traffic")).toHaveLength(4);
    expect(card("Failed").querySelector('[data-slot="kpi-trend-empty"]')).not.toBeNull();
    expect(card("Failed").querySelector('[data-slot="kpi-pills"]')).toBeNull();
    expect(within(card("Failed")).getByText("0 succeeded")).toBeInTheDocument();
    expect(within(card("Failed")).queryByText(/success$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d failed$/)).not.toBeInTheDocument();
  });

  it("has nothing to compare over the lifetime", () => {
    renderCards(key(), usage(totals({ requests: 12 })), { range: "all" });
    expect(screen.getAllByText("Since the key was created")).toHaveLength(3);
    expect(within(card("Failed")).getByText("Nothing failed")).toBeInTheDocument();
    expect(screen.getAllByText("Lifetime")).toHaveLength(4);
  });

  it("draws a measure that stayed at zero flat, without No traffic when requests came", () => {
    renderCards(key(), usage(totals({ requests: 3, failed: 3 }), totals({ requests: 1 })));
    expect(card("Credits").querySelector('[data-slot="kpi-trend-empty"]')).not.toBeNull();
    expect(screen.queryByText("No traffic")).not.toBeInTheDocument();
    // Failures draw their pills.
    expect(card("Failed").querySelector('[data-slot="kpi-pills"]')).not.toBeNull();
    expect(within(card("Failed")).getByText("0.0% success")).toBeInTheDocument();
  });

  it("shows a key without limits as used since created and No key limit", () => {
    renderCards(
      key({ successfulCalls: 436, creditsUsed: 0.000_000_1, tokensUsed: 8_500_000 }),
      usage(totals({ requests: 1 })),
    );
    expect(within(card("Requests")).getByText("436 since created")).toBeInTheDocument();
    expect(within(card("Credits")).getByText("<0.01 since created")).toBeInTheDocument();
    expect(within(card("Tokens")).getByText("8.5M since created")).toBeInTheDocument();
    expect(screen.getAllByText("No key limit")).toHaveLength(3);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("turns a limit amber from 75% and red once reached or overrun", () => {
    renderCards(
      key({
        callLimit: 500,
        successfulCalls: 370,
        creditLimit: 40,
        creditsUsed: 39.27,
        tokenLimit: 1_000_000,
        tokensUsed: 1_041_377,
      }),
      usage(totals({ requests: 1 })),
    );
    const footer = (label: string) =>
      card(label).querySelector('[data-slot="card-footer"]') as HTMLElement;
    expect(footer("Requests")).toHaveAttribute("data-limit", "default");
    expect(footer("Requests")).toHaveTextContent("370 of 50074% of key limit");
    expect(footer("Credits")).toHaveAttribute("data-limit", "warning");
    expect(footer("Credits")).toHaveTextContent("39.27 of 40.0098% of key limit");
    // "1M of 1M" would hide the overrun: the figures go in full.
    expect(footer("Tokens")).toHaveAttribute("data-limit", "destructive");
    expect(footer("Tokens")).toHaveTextContent("1,041,377 of 1,000,000Limit reached · 104%");
    // The meter stops at full instead of drawing past its track.
    const meter = within(footer("Tokens")).getByRole("meter", {
      name: "Tokens used: 1,041,377 of 1,000,000",
    });
    expect(meter).toHaveAttribute("aria-valuenow", "1000000");
  });

  it("keeps a limit with some left under 100%, in short figures that differ", () => {
    renderCards(
      key({ tokenLimit: 2_000_000, tokensUsed: 1_999_999, callLimit: 10, successfulCalls: 10 }),
      usage(totals({ requests: 1 })),
    );
    expect(within(card("Tokens")).getByText("1,999,999 of 2,000,000")).toBeInTheDocument();
    expect(within(card("Tokens")).getByText("99% of key limit")).toBeInTheDocument();
    expect(within(card("Requests")).getByText("Limit reached · 100%")).toBeInTheDocument();
  });

  it("shows bars while the range loads and dashes when it failed", () => {
    const { unmount, container } = renderCards(key(), undefined);
    expect(container.querySelector('[data-slot="usage-kpis"]')).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByText("Not loaded")).not.toBeInTheDocument();
    unmount();
    renderCards(key(), undefined, { isError: true });
    expect(screen.getAllByText("Not loaded")).toHaveLength(4);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });
});

describe("key facts", () => {
  function fact(label: string): HTMLElement {
    return screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
  }

  it("shows no limits, no expiry and every model for a plain key", () => {
    renderWithProviders(<KeyFacts apiKey={key()} />);
    const strip = screen.getByRole("region", { name: "Key details" });
    expect(within(strip).getByText("No limit")).toBeInTheDocument();
    expect(fact("Expires")).toHaveTextContent("Never");
    expect(fact("Allowed models")).toHaveTextContent("All models");
    expect(fact("Last used")).toHaveTextContent("5 minutes ago");
  });

  it.each([
    [10 * DAY + 60, "later", "In 10d"],
    [2 * DAY + 4 * 3600 + 30, "soon", "In 2d 4h"],
    [-3 * DAY - 60, "past", "Expired 3d ago"],
  ])("reads an expiry %i s away as %s", (offset, kind, text) => {
    renderWithProviders(<KeyFacts apiKey={key({ expiresAt: NOW + offset })} />);
    const value = fact("Expires").querySelector("[data-expiry]");
    expect(value).toHaveAttribute("data-expiry", kind);
    expect(value).toHaveTextContent(text);
    // Soon and past are amber; a later expiry is plain.
    expect(value?.classList.contains("text-warning-foreground")).toBe(kind !== "later");
  });

  it("counts the expiry down while the key stays the same", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const now = Math.floor(Date.now() / 1000);
    renderWithProviders(<KeyFacts apiKey={key({ expiresAt: now + 10 * 60 + 30 })} />);
    expect(fact("Expires")).toHaveTextContent("In 10m");
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(fact("Expires")).toHaveTextContent("In 7m");
  });

  it("lists a restricted key's models as chips, a long ID cut to the strip", () => {
    const long = `claude-${"x".repeat(73)}`;
    renderWithProviders(
      <KeyFacts apiKey={key({ allowedModels: ["claude-haiku-4.5", long], rpmLimit: 30 })} />,
    );
    const list = screen.getByRole("list", { name: "Allowed models" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["claude-haiku-4.5", long]);
    expect(within(list).getByText(long)).toHaveClass("truncate");
    expect(fact("Requests per minute")).toHaveTextContent("30/min");
  });

  it("says Never used, and shows a dash for a key without a creation date", () => {
    renderWithProviders(<KeyFacts apiKey={key({ lastUsedAt: 0, createdAt: 0 })} />);
    expect(fact("Last used")).toHaveTextContent("Never used");
    expect(fact("Created")).toHaveTextContent("—");
  });

  it("keeps its five facts as bars while the key loads", () => {
    renderWithProviders(<KeyFacts apiKey={undefined} />);
    expect(screen.getAllByRole("term")).toHaveLength(5);
    expect(screen.queryByText("Never")).not.toBeInTheDocument();
  });
});
