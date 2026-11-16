import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithKey, USER_API_BASE, type UserRequest } from "@/lib/api/user-panel";
import { getUserToken } from "@/lib/auth/user-session";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { toast } from "@/lib/toast";
import { renderApp } from "@/test/render";
import { userKeyStatus } from "./key-status";
import { resetUserPanelMock } from "./mocks";

type StoredKey = (typeof mockDb.apiKeys)[number];

/** Every /admin/api request the page sends: a key holder's page must send none. */
let adminCalls: string[] = [];

beforeEach(() => {
  resetUserPanelMock();
  // Most tests read a server that checks keys everywhere; one turns it off for its notice.
  mockDb.settings.requireApiKey = true;
  adminCalls = [];
  mockServer.events.on("request:start", ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/admin/api")) adminCalls.push(`${request.method} ${pathname}`);
  });
});

afterEach(() => {
  mockServer.events.removeAllListeners();
  vi.restoreAllMocks();
});

/** Signs in to the mock with the small dataset's first key ("team-a"), changed by `patch`. */
async function signIn(patch: Partial<StoredKey> = {}): Promise<StoredKey> {
  const stored = mockDb.apiKeys[0];
  Object.assign(stored, patch);
  await signInWithKey(stored.key, false);
  return stored;
}

async function renderPanel() {
  // No admin session: the page must work on the key holder's token alone.
  const result = await renderApp("/user", { authed: false });
  await screen.findByRole("heading", { level: 1, name: "team-a" });
  return result;
}

function request(index: number): UserRequest {
  const failed = index % 5 === 4;
  return {
    ts: mockNowUnix() - index * 60,
    model: failed ? "claude-failing" : `claude-model-${index}`,
    endpoint: "claude",
    client: index % 2 === 0 ? "claude-code" : "",
    inTokens: 1200,
    outTokens: 300,
    totalTokens: 1500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: failed ? 0 : 0.05,
    success: !failed,
    status: failed ? 429 : 200,
    // 75 minutes on the newest row: "1h 15m".
    durationMs: index === 0 ? 4_500_000 : 2_000,
    errorType: failed ? "rate_limit" : "",
    requestId: `req_${index}`,
    tries: failed ? 3 : 1,
  };
}

/**
 * GET /user/api/requests over 23 requests (every fifth failed), sorted by time or model, with
 * the counts per status; records each query.
 */
function serveRequests(): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  const all = Array.from({ length: 23 }, (_, index) => request(index));
  const failed = all.filter((row) => !row.success).length;
  mockServer.use(
    http.get(`${USER_API_BASE}/requests`, ({ request: req }) => {
      const params = new URL(req.url).searchParams;
      seen.push(params);
      const status = params.get("status");
      const page = Number(params.get("page"));
      const pageSize = Number(params.get("pageSize"));
      const sort = params.get("sort") === "model" ? "model" : "time";
      const order = params.get("order") === "asc" ? "asc" : "desc";
      const rows = (
        status === "error"
          ? all.filter((row) => !row.success)
          : status === "success"
            ? all.filter((row) => row.success)
            : all
      ).toSorted((a, b) => {
        const compare = sort === "model" ? a.model.localeCompare(b.model) : a.ts - b.ts;
        return order === "asc" ? compare : -compare;
      });
      return HttpResponse.json({
        requests: rows.slice((page - 1) * pageSize, page * pageSize),
        total: rows.length,
        page,
        pageSize,
        sort,
        order,
        counts: { all: all.length, succeeded: all.length - failed, failed },
      });
    }),
  );
  return seen;
}

async function requestsTable(): Promise<HTMLElement> {
  const table = await screen.findByRole("table", { name: "Recent requests" });
  await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(1));
  return table;
}

function bodyRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole("row").slice(1);
}

describe("userKeyStatus", () => {
  it("reads off before expired, and a passed expiry as expired", () => {
    const now = 1_800_000_000;
    expect(userKeyStatus({ enabled: true, expired: false, expiresAt: 0 }, now)).toBe("active");
    expect(userKeyStatus({ enabled: false, expired: true, expiresAt: now - 1 }, now)).toBe("off");
    expect(userKeyStatus({ enabled: true, expired: true, expiresAt: now - 1 }, now)).toBe(
      "expired",
    );
    expect(userKeyStatus({ enabled: true, expired: false, expiresAt: now - 1 }, now)).toBe(
      "expired",
    );
  });
});

describe("/user", () => {
  it("sends a visitor without a session to the key sign-in page", async () => {
    const { router } = await renderApp("/user", { authed: false });
    await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Check your API key" }),
    ).toBeInTheDocument();
    expect(adminCalls).toEqual([]);
  });

  it("heads the page with the key's name, masked key and Active status, calling no admin API", async () => {
    const stored = await signIn();
    await renderPanel();
    expect(screen.getByText(stored.keyMasked)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText(/The proxy refuses its requests/)).not.toBeInTheDocument();
    // Every card has loaded before the check, so a late admin call would show.
    await requestsTable();
    await screen.findByRole("list", { name: "Models" });
    expect(adminCalls).toEqual([]);
  });

  it("shows when an active key expires", async () => {
    await signIn({ expiresAt: mockNowUnix() + 30 * 86_400 });
    await renderPanel();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/^Expires /)).toBeInTheDocument();
  });

  it("says a turned-off key gets its requests refused", async () => {
    await signIn({ enabled: false });
    await renderPanel();
    expect(screen.getByText("Turned off")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This key is turned off. The proxy refuses its requests until the admin turns it on again.",
    );
  });

  it("says calls to the server's own address are not counted when keys are not required", async () => {
    mockDb.settings.requireApiKey = false;
    await signIn();
    await renderPanel();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This server doesn't ask for API keys on its own address, so calls made there don't count here. Calls through its public link always do.",
    );
  });

  it("says an expired key gets its requests refused", async () => {
    await signIn({ expiresAt: mockNowUnix() - 3600 });
    await renderPanel();
    expect(screen.getAllByText("Expired").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toHaveTextContent(/^This key expired on .+\. The proxy/);
  });

  it("shows the usage cards with the key's limits, and its rate limit, models and dates", async () => {
    await signIn({ rpmLimit: 60, allowedModels: ["claude-sonnet-4.5", "claude-opus-4.8"] });
    await renderPanel();
    const usage = screen.getByRole("region", { name: "Usage" });
    // Each limit sits under the card of its measure, amber past 75%.
    expect(
      within(usage).getByRole("meter", { name: "Tokens used: 1,874,210 of 2,000,000" }),
    ).toBeInTheDocument();
    expect(within(usage).getByText("1.9M of 2M")).toBeInTheDocument();
    expect(within(usage).getByText("94% of key limit")).toHaveClass("text-warning-foreground");
    expect(within(usage).getByText("46.20 of 50.00")).toBeInTheDocument();
    // The range's figures load with their comparison to the 24 hours before.
    await waitFor(() =>
      expect(usage.querySelector('[data-slot="usage-kpis"]')).not.toHaveAttribute("aria-busy"),
    );
    expect(
      within(usage).getAllByText(/vs previous 24 hours|the 24 hours before/).length,
    ).toBeGreaterThanOrEqual(3);
    const details = screen.getByRole("region", { name: "Key details" });
    expect(within(details).getByText("60/min")).toBeInTheDocument();
    expect(
      within(within(details).getByRole("list", { name: "Allowed models" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["claude-sonnet-4.5", "claude-opus-4.8"]);
    expect(within(details).getByText("Never")).toBeInTheDocument();
    // A key limited to models asks for the first of them in the client setup request.
    const setup = screen.getByRole("region", { name: "Client setup" });
    const code = setup.querySelector("pre")?.textContent ?? "";
    expect(code).toContain('"model": "claude-sonnet-4.5"');
    expect(code).toContain('-H "x-api-key: $KIRO_API_KEY"');
  });

  it("shows the admin Endpoints and Client setup cards with the key's own Require API key", async () => {
    await signIn();
    const { user } = await renderPanel();
    const list = screen.getByRole("list", { name: "Endpoints" });
    const origin = window.location.origin;
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.querySelector('[data-slot="endpoint-url"]')?.textContent),
    ).toEqual([
      `${origin}/v1/messages`,
      `${origin}/v1/messages/count_tokens`,
      `${origin}/v1/chat/completions`,
      `${origin}/v1/responses`,
      `${origin}/v1/models`,
      `${origin}/v1/codex/models`,
      `${origin}/v1/stats`,
    ]);
    // The hint speaks to the key holder: no "this page" keys, no admin password.
    expect(screen.getByTestId("endpoints-auth-hint")).toHaveTextContent(
      /^Send your API key as Authorization: Bearer <key> or X-Api-Key: <key>\.$/,
    );
    const setup = screen.getByRole("region", { name: "Client setup" });
    expect(within(setup).queryByRole("note")).not.toBeInTheDocument();
    await user.click(within(setup).getByRole("tab", { name: "Codex" }));
    expect(within(setup).getByRole("tabpanel", { name: "Codex" })).toHaveTextContent(
      `base_url = "${origin}/v1"`,
    );
    await requestsTable();
    expect(adminCalls).toEqual([]);
  });

  it("says in both cards that this server takes calls without a key when keys are not required", async () => {
    mockDb.settings.requireApiKey = false;
    await signIn();
    await renderPanel();
    expect(screen.getByTestId("endpoints-auth-hint")).toHaveTextContent(
      "This server's own address doesn't ask for one now, but calls without it don't count here.",
    );
    const setup = screen.getByRole("region", { name: "Client setup" });
    expect(within(setup).getByRole("note")).toHaveTextContent(
      "API keys are not required now, so any value works.",
    );
    await requestsTable();
    expect(adminCalls).toEqual([]);
  });

  it("reads All models for a key without a model list", async () => {
    await signIn({ allowedModels: [] });
    await renderPanel();
    const details = screen.getByRole("region", { name: "Key details" });
    expect(within(details).getByText("All models")).toBeInTheDocument();
  });

  it("shows the Requests table's columns and tabs with counts, without accounts, keys or search", async () => {
    serveRequests();
    await signIn();
    await renderPanel();
    const table = await requestsTable();
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    // The status rides on the time rail and the caller under the model, as on Requests; the
    // detail columns are the key holder's own.
    expect(headers).toEqual([
      "Time",
      "Model",
      "Tokens",
      "Cache hit",
      "Credits",
      "Duration",
      "Speed",
      "HTTP",
      "Error",
      "Request ID",
    ]);
    const rows = bodyRows(table);
    expect(within(rows[0]).getByText("Claude Code")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Claude API")).toBeInTheDocument();
    // 300 output tokens in 2 s; no cache read of the 1,200 input; one try; the ID to quote.
    expect(rows[1].querySelector("[data-output-speed]")).toHaveTextContent("150 tok/s");
    expect(rows[1].querySelector("[data-slot=cache-hit]")).toHaveTextContent("0%");
    expect(rows[1].querySelector("[data-slot=http-status]")).toHaveTextContent("HTTP 2001 try");
    expect(rows[1].querySelector("[data-slot=request-id]")).toHaveTextContent("req_1");
    expect(within(rows[1]).getByRole("button", { name: "Copy request ID" })).toBeInTheDocument();
    expect(rows[4].querySelector("[data-slot=http-status]")).toHaveTextContent("HTTP 4293 tries");
    const tabs = within(screen.getByRole("tablist", { name: "Status" }));
    expect(tabs.getByRole("tab", { name: /^All/ })).toHaveTextContent("All23");
    expect(tabs.getByRole("tab", { name: /^Succeeded/ })).toHaveTextContent("Succeeded19");
    expect(tabs.getByRole("tab", { name: /^Failed/ })).toHaveTextContent("Failed4");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    // Rows open nothing: the detail sheet shows accounts, attempts and the conversation.
    for (const row of bodyRows(table)) expect(row).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("button", { name: /^Open details/ })).not.toBeInTheDocument();
  });

  it("filters the requests by status and pages through them", async () => {
    const seen = serveRequests();
    await signIn();
    const { user } = await renderPanel();
    const table = await requestsTable();
    expect(bodyRows(table)).toHaveLength(10);
    // In the Duration column, and under the credits below a 64rem card.
    expect(within(table).getAllByText("1h 15m")).toHaveLength(2);
    expect(screen.getByText("1–10 of 23")).toBeInTheDocument();
    expect(seen.at(-1)?.get("status")).toBe("all");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("11–20 of 23")).toBeInTheDocument());
    expect(seen.at(-1)?.get("page")).toBe("2");

    // A new filter starts on page 1.
    await user.click(screen.getByRole("tab", { name: /^Failed/ }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(4));
    expect(seen.at(-1)?.get("status")).toBe("error");
    expect(seen.at(-1)?.get("page")).toBe("1");
    for (const row of bodyRows(table)) {
      expect(within(row).getByText("Failed 429")).toHaveClass("sr-only");
      // Under the time below a 72rem card, in the Error column above it, without the status the
      // HTTP column shows; never a message.
      expect(within(row).getAllByText("Rate limited")).toHaveLength(2);
      expect(within(row).queryByText("Rate limited · 429")).not.toBeInTheDocument();
      expect(row.querySelector("[data-slot=http-status]")).toHaveTextContent("HTTP 4293 tries");
      expect(row.querySelector("[data-slot=error-message]")).toBeNull();
    }
    // Four requests fit one page: no pager.
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^Succeeded/ }));
    await waitFor(() => expect(seen.at(-1)?.get("status")).toBe("success"));
    await waitFor(() => expect(screen.getByText("1–10 of 19")).toBeInTheDocument());
  });

  it("sorts on the server from a header or Sort by, offering no account sorts", async () => {
    const seen = serveRequests();
    await signIn();
    const { user } = await renderPanel();
    const table = await requestsTable();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(seen.at(-1)?.get("page")).toBe("2"));

    // A new sort starts on page 1, ascending except by time.
    await user.click(within(table).getByRole("button", { name: "Model" }));
    await waitFor(() => expect(seen.at(-1)?.get("sort")).toBe("model"));
    expect(seen.at(-1)?.get("order")).toBe("asc");
    expect(seen.at(-1)?.get("page")).toBe("1");
    await waitFor(() => expect(bodyRows(table)[0]).toHaveTextContent("claude-failing"));
    await user.click(within(table).getByRole("button", { name: "Model" }));
    await waitFor(() => expect(seen.at(-1)?.get("order")).toBe("desc"));

    await user.click(screen.getByRole("button", { name: "Sort by: Model" }));
    const options = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
    expect(options).toEqual([
      "Time",
      "Status",
      "Model",
      "Tokens",
      "Credits",
      "Duration",
      "Ascending",
      "Descending",
    ]);
    await user.click(screen.getByRole("menuitemradio", { name: "Tokens" }));
    await waitFor(() => expect(seen.at(-1)?.get("sort")).toBe("tokens"));
    expect(seen.at(-1)?.get("order")).toBe("asc");
    expect(screen.getByRole("button", { name: "Sort by: Tokens" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rows: 10" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "25" }));
    await waitFor(() => expect(seen.at(-1)?.get("pageSize")).toBe("25"));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(23));
  });

  it("says when a filter has no requests and offers all of them", async () => {
    mockServer.use(
      http.get(`${USER_API_BASE}/requests`, ({ request: req }) => {
        const params = new URL(req.url).searchParams;
        const rows = params.get("status") === "error" ? [] : [request(0)];
        return HttpResponse.json({ requests: rows, total: rows.length, page: 1, pageSize: 10 });
      }),
    );
    await signIn();
    const { user } = await renderPanel();
    await requestsTable();
    await user.click(screen.getByRole("tab", { name: /^Failed/ }));
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("signs out: revokes the session and goes to the key sign-in page", async () => {
    let deleted = 0;
    mockServer.use(
      http.delete(`${USER_API_BASE}/session`, () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await signIn();
    const { router, user } = await renderPanel();
    const navigate = vi.spyOn(router, "navigate");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
    // One navigation, replacing /user: Back must not return to the signed-out panel.
    const toLogin = navigate.mock.calls.filter(([options]) => options?.to === "/user/login");
    expect(toLogin).toHaveLength(1);
    expect(toLogin[0]?.[0]).toMatchObject({ replace: true });
    expect(deleted).toBe(1);
    expect(getUserToken()).toBeNull();
    expect(adminCalls).toEqual([]);
  });

  it("toasts once and goes to the key sign-in page when the session expires", async () => {
    const warning = vi.spyOn(toast, "warning");
    await signIn();
    const { router, queryClient } = await renderPanel();
    // The token stops working: every panel request now gets the 401.
    mockServer.use(
      http.get(`${USER_API_BASE}/*`, () =>
        jsonError(401, "Unauthorized", { code: "user_session_expired" }),
      ),
    );
    await queryClient.refetchQueries();
    await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "Your session expired. Sign in again.",
      expect.objectContaining({ id: "user-session-expired" }),
    );
    expect(getUserToken()).toBeNull();
  });
});
