import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { buildStatus } from "@/lib/mocks/fixtures";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";

// /observe/recent-requests belongs to the Requests feature's mocks.
beforeEach(() => {
  mockServer.use(
    http.get(apiUrl("/observe/recent-requests"), ({ request }) => {
      const pageSize = Number(new URL(request.url).searchParams.get("pageSize") ?? 25);
      return HttpResponse.json({
        requests: mockDb.requests.slice(0, pageSize),
        total: mockDb.requests.length,
        page: 1,
        pageSize,
        sort: "time",
        order: "desc",
        persistent: true,
      });
    }),
  );
});

/** A tile of the joined KPI strip (the four /status totals). */
async function statCard(label: string): Promise<HTMLElement> {
  const region = await screen.findByRole("region", { name: "Totals" });
  const title = await within(region).findByText(label, { selector: "p" });
  const card = title.closest<HTMLElement>('[data-slot="stat-tile"]');
  if (!card) throw new Error(`no stat tile for ${label}`);
  return card;
}

/** The six live tiles: separate StatTile cards in the "Live traffic" region. */
function liveTiles(container: HTMLElement): NodeListOf<HTMLElement> {
  return container.querySelectorAll<HTMLElement>(
    'section[aria-label="Live traffic"] [data-slot="stat-tile"]',
  );
}

function metricValue(card: HTMLElement, label: string): string {
  const term = within(card).getByText(label);
  return term.closest("div")?.querySelector("dd")?.textContent ?? "";
}

function errorsTable(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: "Recent errors" });
}

describe("OverviewPage", () => {
  // The first test renders the whole app cold; on a loaded machine that can pass 5 s.
  it("shows the four status cards with values from /status", { timeout: 20_000 }, async () => {
    await renderApp("/");
    const status = buildStatus(mockDb);

    const accounts = await statCard("Accounts");
    expect(within(accounts).getByText(String(mockDb.accounts.length))).toBeInTheDocument();
    expect(metricValue(accounts, "Available")).toBe(`${status.available} / ${status.accounts}`);

    const failed = await statCard("Failed");
    expect(metricValue(failed, "Unavailable")).toBe(String(status.accounts - status.available));

    expect(await statCard("Requests")).toBeInTheDocument();
    expect(await statCard("Succeeded")).toBeInTheDocument();
  });

  it("keeps the six sections in order, the totals as one joined strip", async () => {
    const { container } = await renderApp("/");
    await statCard("Accounts");
    const order = [
      "Totals",
      "Live traffic",
      "Traffic",
      "Traffic by account",
      "Model mix",
      "Recent activity",
    ];
    const names = screen.getAllByRole("region").map((region) => {
      const labelledBy = region.getAttribute("aria-labelledby");
      return labelledBy
        ? document.getElementById(labelledBy)?.textContent
        : region.getAttribute("aria-label");
    });
    expect(names.filter((name) => name && order.includes(name))).toEqual(order);
    const totals = screen.getByRole("region", { name: "Totals" });
    expect(totals.querySelectorAll('[data-slot="stat-group-card"]')).toHaveLength(1);
    await waitFor(() => expect(liveTiles(container)).toHaveLength(6));
    // The live tiles are separate cards, not a second joined strip.
    const live = screen.getByRole("region", { name: "Live traffic" });
    expect(live.querySelector('[data-slot="stat-group-card"]')).toBeNull();
  });

  it("colours the Failed icon, never its value", async () => {
    await renderApp("/");
    const failed = await statCard("Failed");
    expect(failed).toHaveAttribute("data-tone", "danger");
    const value = failed.querySelector('[data-slot="stat-value"]');
    expect(value).toHaveClass("text-foreground");
    expect(value).not.toHaveClass("text-destructive-foreground");
  });

  it("shows no success or failure rate, and no error red, before any request", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () =>
        HttpResponse.json({
          ...buildStatus(mockDb),
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
        }),
      ),
    );
    await renderApp("/");
    const failed = await statCard("Failed");
    expect(metricValue(failed, "Failure rate")).toBe("—");
    const rate = within(failed).getByText("Failure rate").closest("div")?.querySelector("dd");
    expect(rate).toHaveClass("text-muted-foreground");
    expect(rate).not.toHaveClass("text-destructive-foreground");
    expect(metricValue(await statCard("Succeeded"), "Success rate")).toBe("—");
  });

  it("shows the SSE state in the live badge", async () => {
    await renderApp("/");
    // Vitest has no EventSource, so the events provider stays closed.
    expect(await screen.findByText("Offline")).toBeInTheDocument();
  });

  it("shows six live tiles and the 5-minute error rate as a percentage", async () => {
    const { container } = await renderApp("/");
    await waitFor(() => {
      expect(liveTiles(container)).toHaveLength(6);
    });
    const live = screen.getByRole("region", { name: "Live traffic" });
    const errRate = within(live).getByText("Errors (5 min)").closest('[data-slot="stat-tile"]');
    expect(errRate).not.toBeNull();
    expect(errRate?.querySelector('[data-slot="stat-value"]')?.textContent).toMatch(/^\d+\.\d%$/);
  });

  it("draws the live series as bar sparklines and active accounts against available ones", async () => {
    const flat = (value: number) => Array.from({ length: 30 }, () => value);
    // The error rate doubles in the newest minutes: its newest bar and icon turn red.
    const errRate = [...flat(0.1).slice(2), 0.2, 0.2];
    mockServer.use(
      http.get(apiUrl("/observe/overview"), () =>
        HttpResponse.json({
          startedAt: 1_700_000_000,
          nowUnix: 1_700_003_600,
          rpm1: 12,
          rpm5Avg: 10,
          errRate5: 0.12,
          inTpm5: 4000,
          outTpm5: 900,
          credits5: 1,
          credits60: 7.5,
          errors60: 3,
          successes60: 40,
          retries60: 1,
          activeAccts: 2,
          totalAccts: 9,
          totalModels: 3,
          enabledAccts: 6,
          availableAccts: 4,
          series: {
            rpm: flat(10),
            errRate,
            inTpm: flat(4000),
            outTpm: flat(900),
            credits: flat(1),
          },
        }),
      ),
    );
    const { container } = await renderApp("/");
    const live = await screen.findByRole("region", { name: "Live traffic" });
    await waitFor(() => expect(liveTiles(container)).toHaveLength(6));
    const tiles = [...liveTiles(container)];
    // Every tile fills its trend slot: bars for the five series (lazy chart code), a meter for
    // Active accounts. jsdom has no layout, so the sparkline draws its box without the svg.
    await waitFor(() => {
      for (const tile of tiles) {
        expect(tile.querySelector('[data-slot="stat-trend"]')?.childElementCount).toBe(1);
      }
    });
    const active = within(live).getByText("Active accounts").closest('[data-slot="stat-tile"]');
    expect(active?.querySelector('[data-slot="stat-value"]')?.textContent).toBe("2 / 4");
    expect(active?.querySelector('[data-slot="meter-indicator"]')).not.toBeNull();
    const errors = within(live).getByText("Errors (5 min)").closest('[data-slot="stat-tile"]');
    expect(errors).toHaveAttribute("data-tone", "danger");
    expect(errors?.querySelector('[data-slot="stat-value"]')).toHaveClass("text-foreground");
  });

  it("draws the totals' last half hour as bars from the live series, Accounts as a meter", async () => {
    // The heatmap never answers: the bars must come from the live series alone.
    mockServer.use(
      http.get(apiUrl("/observe/account-heatmap"), async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    await renderApp("/");
    const trend = (tile: HTMLElement) => tile.querySelector('[data-slot="stat-trend"]');
    for (const label of ["Requests", "Succeeded", "Failed"]) {
      const tile = await statCard(label);
      // The lazy sparkline replaces the loading placeholder in the reserved 28 px slot. jsdom
      // has no layout, so the sparkline draws its box without the svg.
      await waitFor(() => {
        expect(trend(tile)?.childElementCount).toBe(1);
        expect(trend(tile)?.querySelector('[data-slot="skeleton"]')).toBeNull();
      });
      // No heatmap yet, so no hour-over-hour delta; the bars do not wait for it.
      expect(tile.querySelector('[data-slot="stat-delta"]')).toBeNull();
    }
    const accounts = await statCard("Accounts");
    expect(trend(accounts)?.querySelector('[data-slot="meter-indicator"]')).not.toBeNull();
  });

  it("puts the hour-over-hour delta on the totals' delta line", async () => {
    await renderApp("/");
    const requests = await statCard("Requests");
    const delta = await waitFor(() => {
      const node = requests.querySelector('[data-slot="stat-delta"]');
      expect(node).not.toBeNull();
      return node;
    });
    expect(delta?.textContent).toMatch(/^[+-−]?\d[\d.,]*%\s+vs previous hour$/);
  });

  it("asks for the global row only, except for the top five accounts in the heatmap", async () => {
    const urls: URL[] = [];
    mockServer.use(
      http.get(apiUrl("/observe/account-heatmap"), ({ request }) => {
        urls.push(new URL(request.url));
        return undefined;
      }),
    );
    await renderApp("/");
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    await within(heatmap).findByText("All accounts");
    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2));
    const shapes = urls.map((url) => ({
      windowMin: url.searchParams.get("windowMin"),
      scope: url.searchParams.get("scope"),
      top: url.searchParams.get("top"),
    }));
    // The status-card trends and the 1 h chart share one global-only two-hour request.
    expect(shapes).toContainEqual({ windowMin: "120", scope: "global", top: null });
    expect(shapes).toContainEqual({ windowMin: "60", scope: null, top: "5" });
    // Nothing asks for every account's row any more.
    expect(shapes.filter((shape) => shape.scope === null && shape.top === null)).toEqual([]);
  });

  it("counts the busy accounts beyond the top five beside the heatmap title", async () => {
    const busy = (offset: number) => [{ offset, reqs: 3, failures: 0 }];
    mockServer.use(
      http.get(apiUrl("/observe/account-heatmap"), ({ request }) => {
        const params = new URL(request.url).searchParams;
        const windowMin = Number(params.get("windowMin") ?? 60);
        const global = { accountId: "_global_", cells: busy(1) };
        if (params.get("scope") === "global") {
          return HttpResponse.json({ windowMin, nowUnix: 1_700_000_000, global });
        }
        return HttpResponse.json({
          windowMin,
          nowUnix: 1_700_000_000,
          global,
          accounts: Array.from({ length: 5 }, (_, index) => ({
            accountId: `acct-${index}`,
            email: `user${index}@example.com`,
            cells: busy(index + 1),
          })),
          restCount: 3,
        });
      }),
    );
    await renderApp("/");
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    // One subtitle, not a separate meta run beside the description.
    expect(await within(heatmap).findByText("Top 5 of 8 · last 60 min")).toBeInTheDocument();
    expect(heatmap.querySelector('[data-slot="card-meta"]')).toBeNull();
  });

  it("lists at most 10 recent errors", async () => {
    await renderApp("/");
    const table = await errorsTable();
    await waitFor(() => {
      expect(within(table).getAllByRole("row").length).toBeGreaterThan(1);
    });
    // The header row plus at most 10 data rows.
    expect(within(table).getAllByRole("row").length).toBeLessThanOrEqual(11);
    expect(mockDb.errors.length).toBeGreaterThan(10);
  });

  it("masks every email with privacy on", async () => {
    await renderApp("/", { privacy: true });
    const table = await errorsTable();
    await waitFor(() => {
      expect(within(table).getAllByRole("row").length).toBeGreaterThan(1);
    });
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    await within(heatmap).findByText("All accounts");
    const html = document.body.innerHTML;
    // API-key accounts carry a label instead of an address; privacy mode masks only addresses.
    const emails = mockDb.accounts.map((a) => a.email).filter((email) => email.includes("@"));
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(html).not.toContain(email);
    }
  });

  it("shows the full email with privacy off", async () => {
    await renderApp("/", { privacy: false });
    const table = await errorsTable();
    const email = mockDb.errors[0].email as string;
    await waitFor(() => {
      expect(within(table).getAllByText(email).length).toBeGreaterThan(0);
    });
  });

  it("links the recent errors to the failed requests", async () => {
    await renderApp("/");
    const link = await screen.findByRole("link", { name: "View all in Requests" });
    expect(link).toHaveAttribute("href", "/admin/requests?status=failed");
  });

  it("writes the traffic range to the router search", async () => {
    const { user, router } = await renderApp("/");
    const ranges = await screen.findByRole("radiogroup", { name: "Time range" });
    await user.click(within(ranges).getByRole("radio", { name: "6 h" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ range: "6h" });
    });
    expect(await screen.findByText("Requests per 5 min, last 6 h")).toBeInTheDocument();
  });

  it("shows a model-mix load failure only in that card", async () => {
    mockServer.use(
      http.get(apiUrl("/observe/model-mix"), () => jsonError(500, "model mix exploded")),
    );
    await renderApp("/");
    const modelMix = await screen.findByRole("region", { name: "Model mix" });
    expect(await within(modelMix).findByRole("alert")).toBeInTheDocument();
    expect(within(modelMix).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    expect(await statCard("Accounts")).toBeInTheDocument();
    const heatmap = screen.getByRole("region", { name: "Traffic by account" });
    expect(await within(heatmap).findByText("All accounts")).toBeInTheDocument();
    expect(within(heatmap).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("recovers the status cards with Retry after /status fails", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () => jsonError(500, "status exploded"), { once: true }),
    );
    const { user } = await renderApp("/");
    const title = await screen.findByText("Could not load the totals and live traffic");
    const banner = title.closest<HTMLElement>('[role="alert"]');
    if (!banner) throw new Error("the banner is not an alert");
    // The cards keep their titles instead of collapsing into an untitled error block.
    const accounts = await statCard("Accounts");
    expect(within(accounts).getByText("—")).toBeInTheDocument();

    await user.click(within(banner).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(screen.queryByText("Could not load the totals and live traffic")).toBeNull();
    });
    const recovered = await statCard("Accounts");
    expect(metricValue(recovered, "Available")).toMatch(/^\d+ \/ \d+$/);
  });

  it("shows one error banner, not one per card group, when /status and the tiles fail", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () => jsonError(500, "status exploded")),
      http.get(apiUrl("/observe/overview"), () => jsonError(500, "overview exploded")),
    );
    const { container } = await renderApp("/");
    await screen.findByText("Could not load the totals and live traffic");
    await waitFor(() => {
      expect(liveTiles(container)).toHaveLength(6);
    });
    const tiles = screen.getByRole("region", { name: "Live traffic" });
    expect(within(tiles).getByText("Requests/min")).toBeInTheDocument();
    expect(within(tiles).queryByRole("alert")).toBeNull();
    const totals = screen.getByRole("region", { name: "Totals" });
    expect(within(totals).queryByRole("alert")).toBeNull();
    for (const label of ["Accounts", "Requests", "Succeeded", "Failed"]) {
      expect(await statCard(label)).toBeInTheDocument();
    }
    expect(within(totals).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("quiets the section errors to Not loaded under the totals banner, with one Retry", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () => jsonError(500, "status exploded")),
      http.get(apiUrl("/observe/model-mix"), () => jsonError(500, "model mix exploded")),
    );
    await renderApp("/");
    await screen.findByText("Could not load the totals and live traffic");
    const modelMix = screen.getByRole("region", { name: "Model mix" });
    expect(await within(modelMix).findByText("Not loaded")).toBeInTheDocument();
    expect(within(modelMix).queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("falls back to the 1 h range for an unknown ?range= instead of crashing", async () => {
    await renderApp("/?range=7d");
    const traffic = await screen.findByRole("region", { name: "Traffic" });
    expect(within(traffic).getByText("Requests per 2 min, last hour")).toBeInTheDocument();
    expect(within(traffic).getByRole("radio", { name: "1 h" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await statCard("Accounts")).toBeInTheDocument();
  });

  it("opens the live-tile hint on click, so touch screens can read it", async () => {
    await renderApp("/");
    const trigger = await screen.findByRole("button", { name: "Active accounts" });
    // A bare click with no hover first, as a tap sends; a hover-only tooltip stays closed.
    fireEvent.click(trigger);
    expect(await screen.findByText(/Accounts with requests in the last 5 min/)).toBeInTheDocument();
  });

  it("draws the account heatmap without a sideways scroller", async () => {
    await renderApp("/");
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    await within(heatmap).findByText("All accounts");
    expect(heatmap.querySelector('[class*="overflow-x-auto"]')).toBeNull();
    expect(heatmap.querySelector('[class*="min-w-[26rem]"]')).toBeNull();
    // The newest minute stays on screen with its label.
    expect(within(heatmap).getByText("Now")).toBeInTheDocument();
    // Quiet minutes are neutral, not a faint tint of the traffic colour.
    const quiet = heatmap.querySelectorAll<HTMLElement>("[data-empty]");
    expect(quiet.length).toBeGreaterThan(0);
    for (const cell of quiet) {
      expect(cell).toHaveClass("bg-chart-scale-01");
      expect(cell.style.backgroundColor).toBe("");
    }
    // A row total sits beside each row; the old "N more accounts" footer is gone.
    expect(within(heatmap).getByRole("link", { name: "View all accounts" })).toHaveAttribute(
      "href",
      "/admin/accounts",
    );
  });

  it("shows an empty state in the heatmap without traffic", async () => {
    mockServer.use(
      http.get(apiUrl("/observe/account-heatmap"), ({ request }) => {
        const windowMin = Number(new URL(request.url).searchParams.get("windowMin") ?? 60);
        return HttpResponse.json({
          windowMin,
          nowUnix: 1_700_000_000,
          global: { accountId: "_global_", cells: [] },
          accounts: null,
        });
      }),
    );
    await renderApp("/");
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    expect(
      await within(heatmap).findByText("No account activity in the last hour"),
    ).toBeInTheDocument();
    expect(within(heatmap).queryByText("All accounts")).toBeNull();
  });

  it("keeps error messages out of the tab order and uses one dash for missing values", async () => {
    mockServer.use(
      http.get(apiUrl("/observe/recent-errors"), () =>
        HttpResponse.json({
          errors: [
            {
              ts: 1_700_000_000,
              accountId: "",
              email: "",
              model: "-",
              status: 401,
              message: "Invalid or missing API key",
            },
          ],
        }),
      ),
    );
    await renderApp("/");
    const table = await errorsTable();
    const message = await within(table).findByText("Invalid or missing API key");
    expect(message).not.toHaveAttribute("tabindex");
    const row = message.closest("tr") as HTMLElement;
    expect(within(row).queryByText("-")).toBeNull();
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("formats a failed request's badge like the Requests page", async () => {
    const { user } = await renderApp("/");
    await user.click(await screen.findByRole("tab", { name: "Requests" }));
    const table = await screen.findByRole("table", { name: "Recent requests" });
    const failed = mockDb.requests.slice(0, 10).find((r) => !r.success && r.status);
    if (!failed) throw new Error("fixture has no failed request in the first 10");
    expect(await within(table).findAllByText(`Failed ${failed.status}`)).not.toHaveLength(0);
    expect(within(table).queryByText(/Failed · /)).toBeNull();
  });
});
