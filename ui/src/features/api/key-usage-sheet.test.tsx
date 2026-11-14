import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiKeyUsageResponse, ApiKeyUsageTotals } from "@/lib/api/api-key-usage";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { ApiPage } from "./api-page";
import { EMPTY_TOTALS } from "./key-usage-model";
import { ApiKeyUsageSheet } from "./key-usage-sheet";

function totals(partial: Partial<ApiKeyUsageTotals>): ApiKeyUsageTotals {
  const merged = { ...EMPTY_TOTALS, ...partial };
  return { ...merged, tokens: merged.inTokens + merged.outTokens };
}

const busy = totals({
  requests: 5,
  succeeded: 3,
  failed: 2,
  inTokens: 1200,
  outTokens: 340,
  credits: 1.5,
});

function response(range: ApiKeyUsageResponse["range"] = "24h"): ApiKeyUsageResponse {
  return {
    range,
    bucket: range === "24h" ? "hour" : "day",
    bucketSeconds: range === "24h" ? 3600 : 86400,
    tzOffset: 0,
    from: 1_000_000,
    to: 1_007_200,
    nowUnix: 1_007_000,
    buckets: [1_000_000, 1_003_600],
    totals: busy,
    keys: [
      {
        id: "a",
        kind: "key",
        name: "alpha",
        keyMasked: "sk-alp****0001",
        totals: busy,
        series: [EMPTY_TOTALS, busy],
      },
    ],
  };
}

let release: (() => void) | null;

beforeEach(() => {
  release = null;
});

/** `holdFirst` keeps the first response until the test calls `release`. */
function serveUsage(holdFirst = false): void {
  let hold = holdFirst;
  mockServer.use(
    http.get(apiUrl("/api-keys/usage"), async ({ request }) => {
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const range = new URL(request.url).searchParams.get("range") as ApiKeyUsageResponse["range"];
      return HttpResponse.json(response(range));
    }),
  );
}

function legend(sheet: HTMLElement): HTMLElement {
  return within(sheet).getByRole("list", { name: "Series" });
}

/** Starts closed; a button opens the no-key sheet. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        open
      </button>
      <ApiKeyUsageSheet
        entryRef="none"
        identity={{ kind: "none" }}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
}

describe("ApiKeyUsageSheet", () => {
  it("shows loading then legend totals", async () => {
    serveUsage(true);
    const { user } = renderWithProviders(
      <ApiKeyUsageSheet
        entryRef="key:a"
        identity={{ kind: "key", name: "alpha", keyMasked: "sk-alp****0001" }}
        onOpenChange={() => {}}
        open
      />,
    );
    const sheet = await screen.findByRole("dialog", { name: "alpha" });
    expect(within(sheet).getByText("sk-alp****0001")).toBeInTheDocument();
    // Labels hold the layout while loading; the totals come with the data.
    await waitFor(() => expect(release).not.toBeNull());
    expect(within(legend(sheet)).getByText("Succeeded")).toBeInTheDocument();
    expect(within(legend(sheet)).queryByText("3")).toBeNull();

    release?.();
    expect(await within(legend(sheet)).findByText("3")).toBeInTheDocument();
    expect(within(legend(sheet)).getByText("Failed")).toBeInTheDocument();
    expect(within(legend(sheet)).getByText("2")).toBeInTheDocument();
    expect(within(sheet).getByText("Per hour, last 24 hours")).toBeInTheDocument();

    await user.click(within(sheet).getByRole("radio", { name: "Tokens" }));
    expect(within(legend(sheet)).getByText("Input")).toBeInTheDocument();
    expect(within(legend(sheet)).getByText("1,200")).toBeInTheDocument();
    expect(within(legend(sheet)).getByText("340")).toBeInTheDocument();

    await user.click(within(sheet).getByRole("radio", { name: "Credits" }));
    expect(within(legend(sheet)).getByText("1.50")).toBeInTheDocument();
    expect(within(legend(sheet)).queryByText("Failed")).toBeNull();

    await user.click(within(sheet).getByRole("radio", { name: "30d" }));
    expect(await within(sheet).findByText("Per day, last 30 days")).toBeInTheDocument();
    expect(await within(legend(sheet)).findByText("1.50")).toBeInTheDocument();
  });

  it("charts All time by the server's bucket and notes the requests without a date", async () => {
    const dated = totals({ requests: 4, succeeded: 3, failed: 1, credits: 1 });
    const earlier = totals({ requests: 1200, succeeded: 1200, credits: 40 });
    const all = totals({ requests: 1204, succeeded: 1203, failed: 1, credits: 41 });
    mockServer.use(
      http.get(apiUrl("/api-keys/usage"), ({ request }) => {
        const range = new URL(request.url).searchParams.get("range");
        if (range !== "all") return HttpResponse.json(response("24h"));
        return HttpResponse.json({
          ...response("all"),
          bucket: "month",
          bucketSeconds: 0,
          totals: all,
          earlier,
          keys: [
            {
              id: "a",
              kind: "key",
              name: "alpha",
              keyMasked: "sk-alp****0001",
              totals: all,
              series: [EMPTY_TOTALS, dated],
              earlier,
            },
          ],
        } satisfies ApiKeyUsageResponse);
      }),
    );
    const { user } = renderWithProviders(
      <ApiKeyUsageSheet
        entryRef="key:a"
        identity={{ kind: "key", name: "alpha", keyMasked: "sk-alp****0001" }}
        onOpenChange={() => {}}
        open
      />,
    );
    const sheet = await screen.findByRole("dialog", { name: "alpha" });
    expect(await within(sheet).findByText("Per hour, last 24 hours")).toBeInTheDocument();
    expect(within(sheet).queryByText(/have no date/u)).toBeNull();

    await user.click(within(sheet).getByRole("radio", { name: "All time" }));
    expect(await within(sheet).findByText("Per month, all time")).toBeInTheDocument();
    // The legend totals count every request; the bars leave out the 1,200 without a date.
    expect(within(legend(sheet)).getByText("1,203")).toBeInTheDocument();
    expect(
      within(sheet).getByText(
        "1,200 older requests have no date, so the chart leaves them out. The totals include them.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the empty state for a key without traffic", async () => {
    serveUsage();
    renderWithProviders(
      <ApiKeyUsageSheet
        entryRef="key:quiet"
        identity={{ kind: "key", keyMasked: "sk-qui****0002" }}
        onOpenChange={() => {}}
        open
      />,
    );
    const sheet = await screen.findByRole("dialog", { name: "Unnamed key" });
    expect(await within(sheet).findByText("No usage in this range")).toBeInTheDocument();
    expect(within(sheet).getByText("sk-qui****0002")).toBeInTheDocument();
    // Zero totals, not blanks: the range loaded, the key just has nothing in it.
    expect(within(legend(sheet)).getAllByText("0")).toHaveLength(2);
  });

  it("names the no-key group and fetches nothing while closed", async () => {
    let calls = 0;
    mockServer.use(
      http.get(apiUrl("/api-keys/usage"), () => {
        calls += 1;
        return HttpResponse.json(response());
      }),
    );
    const { user } = renderWithProviders(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
    await user.click(screen.getByRole("button", { name: "open" }));
    const sheet = await screen.findByRole("dialog", { name: "No API key" });
    expect(within(sheet).getByText("Requests sent without an API key")).toBeInTheDocument();
    await waitFor(() => expect(calls).toBe(1));
  });

  it("opens from the row menu", async () => {
    mockServer.use(http.get(apiUrl("/settings"), () => HttpResponse.json(mockDb.settings)));
    const { user } = renderWithProviders(<ApiPage />);
    const table = await screen.findByRole("table", { name: "API keys" });
    const cell = await within(table).findByText("team-a");
    const row = cell.closest("tr");
    if (!row) throw new Error("no team-a row");
    await user.click(within(row).getByRole("button", { name: "Actions for team-a" }));
    await user.click(await screen.findByRole("menuitem", { name: "View usage" }));
    const sheet = await screen.findByRole("dialog", { name: "team-a" });
    // The seeded log has team-a traffic in the last 24 hours.
    expect(await within(legend(sheet)).findByText("Succeeded")).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).queryByText("No usage in this range")).toBeNull());
  });
});
