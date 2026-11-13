import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestAttempt } from "@/lib/api/types";
import { formatDurationMs } from "@/lib/format";
import { maskEmail } from "@/lib/privacy";
import { renderWithProviders } from "@/test/render";
import { AttemptsCard } from "./request-attempts";

const FAILOVER_CHAIN: RequestAttempt[] = [
  {
    accountId: "acc-1",
    email: "first.account@example.com",
    endpoint: "Kiro IDE",
    startMs: 0,
    durationMs: 812,
    success: false,
    status: 500,
    errorType: "upstream",
    message: "HTTP 500 from Kiro IDE: first.account@example.com is busy",
  },
  {
    accountId: "acc-1",
    email: "first.account@example.com",
    endpoint: "Kiro IDE",
    startMs: 920,
    durationMs: 640,
    success: false,
    status: 500,
    errorType: "upstream",
    message: "HTTP 500 from Kiro IDE: still busy",
    failover: true,
  },
  {
    accountId: "acc-2",
    email: "second.account@example.com",
    endpoint: "web_search",
    startMs: 1600,
    durationMs: 2104,
    success: true,
  },
];

/** The sheet's own duration text ("812 ms" in English), so the test follows the formatter. */
function ms(value: number): string {
  return formatDurationMs(value, true, "en");
}

function attemptItems(): HTMLElement[] {
  return screen.getAllByTestId("request-attempt");
}

describe("AttemptsCard", () => {
  it("draws each attempt in order with its account, endpoint, result and duration", () => {
    renderWithProviders(<AttemptsCard attempts={FAILOVER_CHAIN} />, { privacy: false });

    const card = screen.getByRole("region", { name: "Attempts" });
    expect(within(card).getByText("3")).toBeInTheDocument();
    const items = attemptItems();
    expect(items).toHaveLength(3);

    const [first, second, third] = items;
    expect(first).toHaveTextContent("Attempt 1");
    expect(first).toHaveTextContent("first.account@example.com");
    expect(first).toHaveTextContent("Kiro IDE");
    expect(first).toHaveTextContent(`at +${ms(0)}`);
    expect(first).toHaveTextContent("Upstream error 500");
    expect(first).toHaveTextContent(ms(812));
    expect(first).toHaveTextContent("Retried on the same account");
    expect(first).not.toHaveTextContent("Moved to another account");

    expect(second).toHaveTextContent(`at +${ms(920)}`);
    expect(second).toHaveTextContent("Moved to another account");
    expect(second).not.toHaveTextContent("Retried");

    expect(third).toHaveTextContent("second.account@example.com");
    expect(third).toHaveTextContent("Web search");
    expect(third).toHaveTextContent("Succeeded");
    expect(third).toHaveTextContent(ms(2104));
    expect(third.dataset.success).toBe("true");
  });

  it("notes attempts the cap left out before the last one", () => {
    const capped: RequestAttempt[] = [
      { ...FAILOVER_CHAIN[0], failover: true },
      { ...FAILOVER_CHAIN[2], endpoint: "Kiro IDE", skipped: 5 },
    ];
    renderWithProviders(<AttemptsCard attempts={capped} />);

    // 2 kept plus 5 left out.
    expect(within(screen.getByRole("region", { name: "Attempts" })).getByText("7")).toBeVisible();
    expect(screen.getByText("5 earlier attempts not recorded")).toBeInTheDocument();
    const list = screen.getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("5 earlier attempts not recorded");
  });

  it("flags output that had already started", () => {
    renderWithProviders(
      <AttemptsCard
        attempts={[
          { ...FAILOVER_CHAIN[0], errorType: "stream", status: undefined, midStream: true },
        ]}
      />,
    );
    const [only] = attemptItems();
    expect(only).toHaveTextContent("Stream interrupted");
    expect(only).toHaveTextContent("Failed after the reply started");
    expect(only).not.toHaveTextContent("Retried");
  });

  it("does not call the next query's try a retry after a search gave up", () => {
    const search = { ...FAILOVER_CHAIN[0], endpoint: "web_search" };
    renderWithProviders(
      <AttemptsCard
        attempts={[
          { ...search, gaveUp: true },
          { ...search, startMs: 1400 },
        ]}
      />,
    );
    const [first, second] = attemptItems();
    expect(first).not.toHaveTextContent("Retried");
    expect(first).not.toHaveTextContent("Moved to another account");
    expect(second).toHaveTextContent("Web search");
  });

  it("masks emails in accounts and messages under privacy mode", () => {
    renderWithProviders(<AttemptsCard attempts={FAILOVER_CHAIN} />, { privacy: true });

    const card = screen.getByRole("region", { name: "Attempts" });
    expect(card).not.toHaveTextContent("first.account@example.com");
    expect(card).not.toHaveTextContent("second.account@example.com");
    const [first] = attemptItems();
    expect(first).toHaveTextContent(maskEmail("first.account@example.com"));
    expect(first).toHaveTextContent(
      `HTTP 500 from Kiro IDE: ${maskEmail("first.account@example.com")} is busy`,
    );
  });

  it("words a failure at a proxy from its code, never with Go's text", () => {
    const raw =
      'Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused';
    const failed = { ...FAILOVER_CHAIN[0], status: undefined, errorType: "proxy" as const };
    renderWithProviders(
      <AttemptsCard
        attempts={[
          {
            ...failed,
            message: raw,
            proxy: { source: "account", code: "connect" },
            failover: true,
          },
          {
            ...failed,
            accountId: "acc-2",
            message: "outbound proxy failed: proxy refused the tunnel",
            proxy: { source: "global", code: "tunnel", status: 403 },
            failover: true,
          },
          {
            ...failed,
            accountId: "acc-3",
            message: "outbound proxy failed: connection timed out",
            proxy: { code: "timeout" },
            failover: true,
          },
          {
            ...failed,
            accountId: "acc-4",
            message: "no healthy outbound proxy in the pool",
            proxy: { source: "pool", code: "no_healthy" },
          },
        ]}
      />,
    );
    const [own, global, old, none] = attemptItems();
    expect(own).toHaveTextContent("Proxy error");
    expect(own).toHaveTextContent(
      "Could not connect through the account's proxy. The proxy refused the connection.",
    );
    expect(own).not.toHaveTextContent("proxyconnect");
    expect(own).not.toHaveTextContent("amazonaws");
    expect(global).toHaveTextContent(
      "Could not connect through the global proxy. The proxy answered with HTTP 403.",
    );
    expect(old).toHaveTextContent("Could not connect through the proxy. Connection timed out.");
    expect(none).toHaveTextContent("No pool proxy was healthy.");
  });

  it("draws nothing for a row without attempts", () => {
    const { container } = renderWithProviders(<AttemptsCard attempts={undefined} />);
    expect(container.querySelector("[data-slot='section-card']")).toBeNull();
    renderWithProviders(<AttemptsCard attempts={[]} />);
    expect(screen.queryByRole("region", { name: "Attempts" })).toBeNull();
  });
});
