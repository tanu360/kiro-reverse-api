import { screen, waitFor, within } from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { accountStatus } from "@/features/accounts/account-model";
import { heatmapQuery } from "@/lib/api/observe";
import { formatPercent } from "@/lib/format";
import { mockDb } from "@/lib/mocks/db";
import { buildStatus } from "@/lib/mocks/fixtures";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";
import { attentionRows } from "./needs-attention";
import { topAccounts } from "./top-accounts";

/** One of the four KPI cards, found by its label in the "Key figures" row. */
async function kpiCard(label: string): Promise<HTMLElement> {
  const row = await screen.findByRole("region", { name: "Key figures" });
  const title = await within(row).findByText(label);
  const card = title.closest<HTMLElement>('[data-slot="kpi-card"]');
  if (!card) throw new Error(`no KPI card for ${label}`);
  return card;
}

/** The accounts the fixture counts as active, as the Accounts card does. */
function activeCount(): number {
  const now = Date.now() / 1000;
  return mockDb.accounts.filter((account) => accountStatus(account, now) === "active").length;
}

const BANNER = "Could not load the totals and live traffic";

describe("OverviewPage", () => {
  // The first test renders the whole app cold; on a loaded machine that can pass 5 s.
  it("shows account health and plan credits on the KPI cards", { timeout: 20_000 }, async () => {
    await renderApp("/");
    const status = buildStatus(mockDb);

    const accounts = await kpiCard("Accounts");
    expect(
      await within(accounts).findByText(`/ ${mockDb.accounts.length} available`),
    ).toBeInTheDocument();
    // The bar's key: each health group with its count.
    const legendValue = (label: string) =>
      within(accounts).getByText(label, { selector: "dt" }).closest("div")?.querySelector("dd")
        ?.textContent;
    expect(legendValue("Available")).toBe(String(activeCount()));
    for (const part of ["Attention", "Banned", "Disabled"]) {
      expect(legendValue(part)).toMatch(/^\d+$/);
    }

    const credits = await kpiCard("Plan credits");
    expect(
      within(credits).getByText(
        formatPercent(status.accountCreditsUsed, status.accountCreditsLimit, "en"),
      ),
    ).toBeInTheDocument();

    expect(await kpiCard("Requests")).toBeInTheDocument();
    expect(await kpiCard("Failed")).toBeInTheDocument();
  });

  it("links every KPI card to the page behind its number", async () => {
    await renderApp("/");
    const row = await screen.findByRole("region", { name: "Key figures" });
    const links: [string, string][] = [
      ["Review accounts needing attention", "/accounts?status=attention"],
      ["View accounts", "/accounts"],
      ["View requests", "/requests"],
      ["View failed requests", "/requests?status=failed"],
    ];
    for (const [name, href] of links) {
      expect(within(row).getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("puts the hour-over-hour change under the requests figure", async () => {
    await renderApp("/");
    const requests = await kpiCard("Requests");
    await waitFor(() => {
      const delta = requests.querySelector('[data-slot="kpi-delta"]');
      const text = delta?.textContent ?? within(requests).queryByText(/hour before/)?.textContent;
      expect(text).toMatch(/vs last hour$|No requests the hour before/);
    });
  });

  it("keeps the sections in order", async () => {
    await renderApp("/");
    await kpiCard("Accounts");
    const order = [
      "Key figures",
      "Traffic",
      "Needs attention",
      "Traffic by account",
      "Model mix",
      "Accounts",
    ];
    const names = screen.getAllByRole("region").map((region) => {
      const labelledBy = region.getAttribute("aria-labelledby");
      return labelledBy
        ? document.getElementById(labelledBy)?.textContent
        : region.getAttribute("aria-label");
    });
    expect(names.filter((name) => name && order.includes(name))).toEqual(order);
  });

  it("shows the SSE state in the live badge", async () => {
    await renderApp("/");
    // Vitest has no EventSource, so the events provider stays closed.
    expect(await screen.findByText("Offline")).toBeInTheDocument();
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
    await within(heatmap).findByRole("list", { name: "Accounts in the last 60 min" });
    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2));
    const shapes = urls.map((url) => ({
      windowMin: url.searchParams.get("windowMin"),
      scope: url.searchParams.get("scope"),
      top: url.searchParams.get("top"),
    }));
    // The KPI cards and the 1 h chart share one global-only two-hour request.
    expect(shapes).toContainEqual({ windowMin: "120", scope: "global", top: null });
    expect(shapes).toContainEqual({ windowMin: "60", scope: null, top: "5" });
    // Nothing asks for every account's row any more.
    expect(shapes.filter((shape) => shape.scope === null && shape.top === null)).toEqual([]);
  });

  it("lists the busiest accounts and switches them to credits", async () => {
    const { user } = await renderApp("/");
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    const list = await within(heatmap).findByRole("list", {
      name: "Accounts in the last 60 min",
    });
    // The five busiest accounts and the rest as one more row.
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(1);
    expect(items.length).toBeLessThanOrEqual(6);

    const measure = within(heatmap).getByRole("radiogroup", { name: "Measure" });
    expect(within(measure).getByRole("radio", { name: "Requests" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(list).queryAllByText(/^\d[\d,]* requests?$/)).toHaveLength(0);
    await user.click(within(measure).getByRole("radio", { name: "Credits" }));
    // In credits each row shows its credits, with its request count under them.
    await waitFor(() => {
      expect(within(list).getAllByText(/^\d[\d,]* requests?$/)).toHaveLength(items.length);
    });
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

  it("keeps a busy account whose attempts all failed over, so the top count adds up", async () => {
    const cell = (reqs: number, retries = 0) => [
      { offset: 1, reqs, failures: 0, ...(retries > 0 ? { retries } : {}) },
    ];
    // The server ranks by requests plus failed attempts: busy 12, failing-over 10, mid 4, a 3, b 3
    // and c 2 come back as the top five plus one more.
    const accounts = [
      { accountId: "busy", email: "busy@example.com", cells: cell(12) },
      { accountId: "failing-over", email: "failover@example.com", cells: cell(0, 10) },
      { accountId: "mid", email: "mid@example.com", cells: cell(4) },
      { accountId: "a", email: "a@example.com", cells: cell(3) },
      { accountId: "b", email: "b@example.com", cells: cell(3) },
    ];
    mockServer.use(
      http.get(apiUrl("/observe/account-heatmap"), ({ request }) => {
        const params = new URL(request.url).searchParams;
        const windowMin = Number(params.get("windowMin") ?? 60);
        const global = { accountId: "_global_", cells: cell(24, 10) };
        if (params.get("scope") === "global") {
          return HttpResponse.json({ windowMin, nowUnix: 1_700_000_000, global });
        }
        return HttpResponse.json({
          windowMin,
          nowUnix: 1_700_000_000,
          global,
          accounts,
          restCount: 1,
        });
      }),
    );
    await renderApp("/", { privacy: false });
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    expect(await within(heatmap).findByText("Top 5 of 6 · last 60 min")).toBeInTheDocument();
    // It keeps its row (with no successful requests) instead of dropping out.
    const list = await within(heatmap).findByRole("list", {
      name: "Accounts in the last 60 min",
    });
    expect(within(list).getByText("failover@example.com")).toBeInTheDocument();
  });

  it("updates the traffic-by-account rows with live data", async () => {
    let newest = 7;
    mockServer.use(
      http.get(apiUrl("/observe/account-heatmap"), ({ request }) => {
        const params = new URL(request.url).searchParams;
        const windowMin = Number(params.get("windowMin") ?? 60);
        const global = {
          accountId: "_global_",
          cells: [
            { offset: 0, reqs: newest, failures: 0 },
            { offset: 5, reqs: 100, failures: 2 },
          ],
        };
        if (params.get("scope") === "global") {
          return HttpResponse.json({ windowMin, nowUnix: 1_700_000_000, global });
        }
        return HttpResponse.json({ windowMin, nowUnix: 1_700_000_000, global, accounts: [] });
      }),
    );
    const { queryClient } = await renderApp("/");
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    const list = await within(heatmap).findByRole("list", {
      name: "Accounts in the last 60 min",
    });
    // No busy accounts: the whole hour never reached an account, with its failures beside it.
    const other = () => within(list).getByText("No account").closest("li")?.textContent;
    expect(other()).toBe("No account1072 failed");

    newest = 31;
    await queryClient.refetchQueries({ queryKey: heatmapQuery(60, { top: 5 }).queryKey });
    await waitFor(() => expect(other()).toBe("No account1312 failed"));
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
    expect(within(heatmap).queryByRole("list", { name: "Accounts in the last 60 min" })).toBeNull();
  });

  it("writes the traffic range to the router search", async () => {
    const { user, router } = await renderApp("/");
    const ranges = await screen.findByRole("radiogroup", { name: "Time range" });
    await user.click(within(ranges).getByRole("radio", { name: "6h" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ range: "6h" });
    });
    expect(await screen.findByText("Requests per 5 min, last 6 hours")).toBeInTheDocument();
  });

  it("offers All time and writes ?range=all", async () => {
    const tzOffsets: string[] = [];
    mockServer.use(
      http.get(apiUrl("/observe/traffic-history"), ({ request }) => {
        tzOffsets.push(new URL(request.url).searchParams.get("tzOffset") ?? "");
        return HttpResponse.json({
          range: "all",
          bucket: "week",
          bucketSeconds: 604800,
          tzOffset: 0,
          from: 1_699_833_600,
          to: 1_701_043_200,
          nowUnix: 1_700_000_000,
          buckets: [1_699_833_600, 1_700_438_400],
          series: [
            { succeeded: 40, failed: 2, retried: 3 },
            { succeeded: 7, failed: 1, retried: 0 },
          ],
          totals: { succeeded: 47, failed: 3, retried: 3 },
        });
      }),
    );
    const { user, router } = await renderApp("/");
    const traffic = await screen.findByRole("region", { name: "Traffic" });
    const ranges = within(traffic).getByRole("radiogroup", { name: "Time range" });
    expect(
      within(ranges)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["1h", "6h", "24h", "Lifetime"]);
    await user.click(within(ranges).getByRole("radio", { name: "Lifetime" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ range: "all" });
    });
    expect(await within(traffic).findByText("Requests per week, lifetime")).toBeInTheDocument();
    expect(
      await within(traffic).findByText("47 succeeded and 3 failed requests in this range."),
    ).toBeInTheDocument();
    expect(tzOffsets).toHaveLength(1);
    expect(within(traffic).queryByText(/have no date/u)).toBeNull();
  });

  it("opens on All time from ?range=all and notes traffic without a date", async () => {
    mockServer.use(
      http.get(apiUrl("/observe/traffic-history"), () =>
        HttpResponse.json({
          range: "all",
          bucket: "day",
          bucketSeconds: 86400,
          tzOffset: 0,
          from: 1_699_401_600,
          to: 1_700_006_400,
          nowUnix: 1_700_000_000,
          buckets: Array.from({ length: 7 }, (_, i) => 1_699_401_600 + i * 86400),
          series: Array.from({ length: 7 }, (_, i) => ({ succeeded: i, failed: 0, retried: 0 })),
          totals: { succeeded: 21 + 26, failed: 0, retried: 2 },
          earlier: { succeeded: 26, failed: 0, retried: 2 },
        }),
      ),
    );
    await renderApp("/?range=all");
    const traffic = await screen.findByRole("region", { name: "Traffic" });
    expect(within(traffic).getByRole("radio", { name: "Lifetime" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await within(traffic).findByText("Requests per day, lifetime")).toBeInTheDocument();
    expect(
      await within(traffic).findByText(
        "26 older requests have no date, so the chart leaves them out. The totals include them.",
      ),
    ).toBeInTheDocument();
    // The legend's totals include them.
    expect(
      within(traffic).getByText("47 succeeded and 0 failed requests in this range."),
    ).toBeInTheDocument();
  });

  it("falls back to the 1 h range for an unknown ?range= instead of crashing", async () => {
    await renderApp("/?range=7d");
    const traffic = await screen.findByRole("region", { name: "Traffic" });
    expect(within(traffic).getByText("Requests per 2 min, last hour")).toBeInTheDocument();
    expect(within(traffic).getByRole("radio", { name: "1h" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await kpiCard("Accounts")).toBeInTheDocument();
  });

  it("keeps the traffic chart when only the previous hour had requests", async () => {
    const heatmap = (cells: { offset: number; reqs: number; failures: number }[]) =>
      http.get(apiUrl("/observe/account-heatmap"), ({ request }) => {
        const windowMin = Number(new URL(request.url).searchParams.get("windowMin") ?? 60);
        return HttpResponse.json({
          windowMin,
          nowUnix: 1_700_000_000,
          global: { accountId: "_global_", cells },
          accounts: null,
        });
      });
    // Offsets 60-119 are the previous hour: the dashed line has something to draw.
    mockServer.use(heatmap([{ offset: 75, reqs: 4, failures: 0 }]));
    const { unmount } = await renderApp("/");
    const traffic = await screen.findByRole("region", { name: "Traffic" });
    // The summary means the data arrived, so a missing empty state is not just still loading.
    await within(traffic).findByText("0 succeeded and 0 failed requests in this range.");
    expect(within(traffic).queryByText("No traffic yet")).toBeNull();
    unmount();

    // Neither hour had a request: the empty state replaces it.
    mockServer.use(heatmap([]));
    await renderApp("/");
    const quiet = await screen.findByRole("region", { name: "Traffic" });
    expect(await within(quiet).findByText("No traffic yet")).toBeInTheDocument();
  });

  it("lists the accounts that need attention, worst first, each with one fix", async () => {
    const rows = attentionRows(mockDb.accounts, Date.now() / 1000);
    expect(rows.length).toBeGreaterThan(1);
    await renderApp("/", { privacy: false });
    const card = await screen.findByRole("region", { name: "Needs attention" });
    expect(await within(card).findByText(`${rows.length} accounts`)).toBeInTheDocument();
    const items = await within(card).findAllByRole("listitem");
    expect(items).toHaveLength(Math.min(5, rows.length));
    items.forEach((item, index) => {
      const row = rows[index];
      expect(item).toHaveAttribute("data-status", row.status);
      // A new token for an expired, missing or suspended one; otherwise the details.
      const refreshes = ["expired", "noToken", "suspended"].includes(row.status);
      expect(within(item).getAllByRole("button")).toHaveLength(1);
      expect(
        within(item).getByRole("button", { name: refreshes ? "Refresh token" : "Details" }),
      ).toBeInTheDocument();
    });
    expect(
      within(card).getByRole("link", { name: "View all accounts that need attention" }),
    ).toHaveAttribute("href", "/accounts?status=attention");
  });

  it("refreshes the token from a needs-attention row", async () => {
    const rows = attentionRows(mockDb.accounts, Date.now() / 1000);
    const index = rows.findIndex((row) => ["expired", "noToken", "suspended"].includes(row.status));
    if (index < 0 || index >= 5) throw new Error("fixture has no refreshable account in view");
    const refreshed: string[] = [];
    mockServer.use(
      http.post(apiUrl("/accounts/:id/refresh"), ({ params }) => {
        refreshed.push(String(params.id));
        return undefined;
      }),
    );
    const { user } = await renderApp("/");
    const card = await screen.findByRole("region", { name: "Needs attention" });
    const items = await within(card).findAllByRole("listitem");
    await user.click(within(items[index]).getByRole("button", { name: "Refresh token" }));
    await waitFor(() => expect(refreshed).toEqual([rows[index].account.id]));
  });

  it("shows an empty state when every account is healthy", async () => {
    const healthy = mockDb.accounts.filter(
      (account) => accountStatus(account, Date.now() / 1000) === "active",
    );
    mockServer.use(http.get(apiUrl("/accounts"), () => HttpResponse.json(healthy)));
    await renderApp("/");
    const card = await screen.findByRole("region", { name: "Needs attention" });
    expect(await within(card).findByText("Every account is healthy")).toBeInTheDocument();
    expect(within(card).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("lists the five busiest accounts with their success rate", async () => {
    const busiest = topAccounts(mockDb.accounts);
    const first = busiest[0];
    const failed = Math.min(first.errorCount, first.requestCount);
    const rate = Math.floor(((first.requestCount - failed) / first.requestCount) * 100);
    await renderApp("/");
    const card = await screen.findByRole("region", { name: "Accounts" });
    const table = await within(card).findByRole("table", { name: "Accounts" });
    await waitFor(() => {
      // The header row plus one row per account.
      expect(within(table).getAllByRole("row")).toHaveLength(busiest.length + 1);
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(`${rate}% success`)).toBeInTheDocument();
    expect(
      within(rows[0]).getByText(
        `${(first.requestCount - failed).toLocaleString("en")}/${first.requestCount.toLocaleString("en")} requests`,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(`${busiest.length} of ${mockDb.accounts.length} accounts`),
    ).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "View all accounts" })).toHaveAttribute(
      "href",
      "/accounts?sort=requests&order=desc",
    );
  });

  it("keeps tags out of the top accounts rows", async () => {
    const first = topAccounts(mockDb.accounts)[0];
    first.tags = ["overview-tag"];
    await renderApp("/");
    const card = await screen.findByRole("region", { name: "Accounts" });
    const table = await within(card).findByRole("table", { name: "Accounts" });
    await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(1));
    expect(within(table).queryByText("overview-tag")).not.toBeInTheDocument();
  });

  it("masks every email with privacy on", async () => {
    await renderApp("/", { privacy: true });
    const accounts = await screen.findByRole("region", { name: "Accounts" });
    const table = await within(accounts).findByRole("table", { name: "Accounts" });
    await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(1));
    const attention = screen.getByRole("region", { name: "Needs attention" });
    await within(attention).findAllByRole("listitem");
    const heatmap = screen.getByRole("region", { name: "Traffic by account" });
    await within(heatmap).findByRole("list", { name: "Accounts in the last 60 min" });
    const html = document.body.innerHTML;
    // API-key accounts carry a label instead of an address; privacy mode masks only addresses.
    const emails = mockDb.accounts.map((a) => a.email).filter((email) => email.includes("@"));
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(html).not.toContain(email);
    }
  });

  it("shows the full email with privacy off", async () => {
    const email = topAccounts(mockDb.accounts)
      .map((account) => account.email)
      .find((value) => value.includes("@"));
    if (!email) throw new Error("fixture has no busy account with an address");
    await renderApp("/", { privacy: false });
    const accounts = await screen.findByRole("region", { name: "Accounts" });
    const table = await within(accounts).findByRole("table", { name: "Accounts" });
    expect(await within(table).findByText(email)).toBeInTheDocument();
  });

  it("shows a model-mix load failure only in that card", async () => {
    mockServer.use(
      http.get(apiUrl("/observe/model-mix"), () => jsonError(500, "model mix exploded")),
    );
    await renderApp("/");
    const modelMix = await screen.findByRole("region", { name: "Model mix" });
    expect(await within(modelMix).findByRole("alert")).toBeInTheDocument();
    expect(within(modelMix).getByText("Could not load the model mix")).toBeInTheDocument();
    expect(within(modelMix).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    expect(await kpiCard("Accounts")).toBeInTheDocument();
    const heatmap = screen.getByRole("region", { name: "Traffic by account" });
    expect(
      await within(heatmap).findByRole("list", { name: "Accounts in the last 60 min" }),
    ).toBeInTheDocument();
    expect(within(heatmap).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("recovers the KPI cards with Retry after /status fails", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () => jsonError(500, "status exploded"), { once: true }),
    );
    const { user } = await renderApp("/");
    const title = await screen.findByText(BANNER);
    const banner = title.closest<HTMLElement>('[role="alert"]');
    if (!banner) throw new Error("the banner is not an alert");
    // The cards keep their titles and show a dash instead of an untitled error block.
    const credits = await kpiCard("Plan credits");
    expect(within(credits).getByText("—")).toBeInTheDocument();

    await user.click(within(banner).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
    const status = buildStatus(mockDb);
    const recovered = await kpiCard("Plan credits");
    expect(
      await within(recovered).findByText(
        formatPercent(status.accountCreditsUsed, status.accountCreditsLimit, "en"),
      ),
    ).toBeInTheDocument();
  });

  it("shows one error banner, not one per card, when /status and the overview fail", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () => jsonError(500, "status exploded")),
      http.get(apiUrl("/observe/overview"), () => jsonError(500, "overview exploded")),
    );
    await renderApp("/");
    await screen.findByText(BANNER);
    const row = screen.getByRole("region", { name: "Key figures" });
    for (const label of ["Accounts", "Plan credits", "Requests", "Failed"]) {
      expect(await kpiCard(label)).toBeInTheDocument();
    }
    expect(within(row).queryByRole("alert")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("quiets the section errors to Not loaded under the totals banner, with one Retry", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () => jsonError(500, "status exploded")),
      http.get(apiUrl("/observe/model-mix"), () => jsonError(500, "model mix exploded")),
    );
    await renderApp("/");
    await screen.findByText(BANNER);
    const modelMix = screen.getByRole("region", { name: "Model mix" });
    expect(await within(modelMix).findByText("Not loaded")).toBeInTheDocument();
    expect(within(modelMix).queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("keeps the KPI cards loading while the heatmap is pending", async () => {
    // The heatmap never answers: the hour cards wait without inventing a figure.
    mockServer.use(
      http.get(apiUrl("/observe/account-heatmap"), async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    await renderApp("/");
    const row = await screen.findByRole("region", { name: "Key figures" });
    expect(row).toHaveAttribute("aria-busy", "true");
    // /status still fills the plan credits.
    const status = buildStatus(mockDb);
    const credits = await kpiCard("Plan credits");
    expect(
      await within(credits).findByText(
        formatPercent(status.accountCreditsUsed, status.accountCreditsLimit, "en"),
      ),
    ).toBeInTheDocument();
    expect(row.querySelectorAll('[data-slot="kpi-delta"]')).toHaveLength(0);
  });
});
