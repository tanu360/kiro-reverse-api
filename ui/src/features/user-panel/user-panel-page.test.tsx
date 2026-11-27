import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithKey, USER_API_BASE, type UserKey, type UserRequest } from "@/lib/api/user-panel";
import { getUserToken } from "@/lib/auth/user-session";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
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

/** A key view with no limits, turned on and never expiring, changed by `patch`. */
function userKey(patch: Partial<UserKey> = {}): UserKey {
  return {
    id: "key-1",
    name: "",
    keyMasked: "sk-abc****wxyz",
    enabled: true,
    expired: false,
    createdAt: 0,
    lastUsedAt: 0,
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

describe("userKeyStatus", () => {
  const now = 1_800_000_000;
  const status = (patch: Partial<UserKey>) => userKeyStatus(userKey(patch), now);
  /** Off, as the proxy leaves a key that reached its token or credit limit. */
  const tokensOut = { enabled: false, tokenLimit: 100, tokensUsed: 100 };
  const creditsOut = { enabled: false, creditLimit: 5, creditsUsed: 5.2 };
  const callsOut = { callLimit: 10, successfulCalls: 10 };

  it("reads off before expired, and a passed expiry as expired", () => {
    expect(status({})).toBe("active");
    expect(status({ enabled: false, expired: true, expiresAt: now - 1 })).toBe("off");
    expect(status({ expired: true, expiresAt: now - 1 })).toBe("expired");
    expect(status({ expiresAt: now - 1 })).toBe("expired");
  });

  it("reads a reached limit in the proxy's order: off (a token or credit limit), expired, calls", () => {
    expect(status(tokensOut)).toBe("tokenLimit");
    expect(status(creditsOut)).toBe("creditLimit");
    expect(status(callsOut)).toBe("callLimit");
    expect(status({ ...tokensOut, ...creditsOut, ...callsOut })).toBe("tokenLimit");
    expect(status({ ...creditsOut, ...callsOut })).toBe("creditLimit");
    // A call limit leaves the key on: off is the admin's doing.
    expect(status({ ...callsOut, enabled: false })).toBe("off");
    // Turned off by its limit and expired too: the proxy refuses it as disabled first, and the
    // admin's table shows Limit reached.
    expect(status({ ...tokensOut, expired: true, expiresAt: now - 1 })).toBe("tokenLimit");
    expect(status({ ...creditsOut, expiresAt: now - 1 })).toBe("creditLimit");
    // On again past its limit: the proxy checks the expiry before the limit.
    expect(status({ ...tokensOut, enabled: true, expiresAt: now - 1 })).toBe("expired");
    expect(status({ ...callsOut, expiresAt: now - 1 })).toBe("expired");
    // Short of a limit, or no limit at all.
    expect(status({ tokenLimit: 100, tokensUsed: 99, callLimit: 10, successfulCalls: 9 })).toBe(
      "active",
    );
    expect(status({ tokensUsed: 5_000, creditsUsed: 50, successfulCalls: 500 })).toBe("active");
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
    expect(screen.getByRole("note")).toHaveTextContent(
      "This server does not ask for API keys on its own address, so calls made there do not count here. Calls through its public link always do.",
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

  it("keeps both cards to the holder's own key when keys are not required", async () => {
    mockDb.settings.requireApiKey = false;
    await signIn();
    await renderPanel();
    // The panel's own alert says keys are not required; the cards only say how to use the key,
    // with none of the admin's "any value works" or "one of your API keys".
    expect(screen.getByTestId("endpoints-auth-hint")).toHaveTextContent(/^Send your API key as /);
    const setup = screen.getByRole("region", { name: "Client setup" });
    expect(within(setup).queryByRole("note")).not.toBeInTheDocument();
    expect(setup).toHaveTextContent("Set KIRO_API_KEY to your API key first.");
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
      "Request ID",
      "Error",
    ]);
    const rows = bodyRows(table);
    expect(within(rows[0]).getByText("Claude Code")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Anthropic API")).toBeInTheDocument();
    // 300 output tokens in 2 s; no cache read of the 1,200 input; the ID to quote; no HTTP status.
    expect(rows[1].querySelector("[data-slot=output-speed]")).toHaveTextContent(/^150 tok\/s$/);
    expect(rows[1].querySelector("[data-slot=cache-hit]")).toHaveTextContent("0%");
    expect(rows[1].querySelector("[data-slot=request-id]")).toHaveTextContent("req_1");
    expect(within(rows[1]).getByRole("button", { name: "Copy request ID" })).toBeInTheDocument();
    expect(table.querySelector("[data-slot=http-status]")).toBeNull();
    const tabs = within(screen.getByRole("tablist", { name: "Status" }));
    expect(tabs.getByRole("tab", { name: /^All/ })).toHaveTextContent("All23");
    expect(tabs.getByRole("tab", { name: /^Succeeded/ })).toHaveTextContent("Succeeded19");
    expect(tabs.getByRole("tab", { name: /^Failed/ })).toHaveTextContent("Failed4");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    // Rows open the detail sheet, by click or key, as on Requests.
    for (const row of bodyRows(table)) expect(row).toHaveAttribute("tabindex", "0");
  });

  it("opens the Requests detail sheet from a row, a key or a narrow row, with only the key's own facts", async () => {
    serveRequests();
    await signIn();
    const { user } = await renderPanel();
    const table = await requestsTable();
    /** The value under a label in the sheet's fact grids. */
    const fact = (dialog: HTMLElement, label: string) =>
      [...dialog.querySelectorAll("dt")].find((term) => term.textContent === label)
        ?.nextElementSibling;

    // The fifth request failed: refused 429 after three tries, with 1,200 input tokens.
    await user.click(within(bodyRows(table)[4]).getByText("claude-failing"));
    let dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "claude-failing" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Failed 429")).toBeInTheDocument();
    expect(within(dialog).getByText("5 of 10 on this page")).toBeInTheDocument();
    expect(fact(dialog, "Error")).toHaveTextContent(/^Rate limited$/);
    expect(fact(dialog, "Status code")).toHaveTextContent(/^429$/);
    expect(fact(dialog, "Client")).toHaveTextContent(/^Claude Code$/);
    expect(fact(dialog, "Attempts")).toHaveTextContent(/^3$/);
    expect(fact(dialog, "Request ID")).toHaveTextContent(/^req_4/);
    expect(within(dialog).getByRole("button", { name: "Copy Request ID" })).toBeInTheDocument();
    expect(fact(dialog, "Duration")).toHaveTextContent("2.00s2,000 ms");
    // None of the admin's: no account, key, message, attempts chain, conversation or replay.
    for (const name of ["Open account", "Conversation", "Replay", "Copy as JSON"]) {
      expect(within(dialog).queryByRole("button", { name })).not.toBeInTheDocument();
    }
    for (const label of ["Account", "API key", "Account ID", "Trace ID", "Conversation ID"]) {
      expect(fact(dialog, label)).toBeUndefined();
    }
    expect(within(dialog).queryByRole("region", { name: "Attempts" })).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("request-message")).not.toBeInTheDocument();

    // Previous steps through the page's rows: the fourth succeeded through the Anthropic API.
    await user.click(within(dialog).getByRole("button", { name: "Previous request" }));
    expect(
      await within(dialog).findByRole("heading", { level: 2, name: "claude-model-3" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("4 of 10 on this page")).toBeInTheDocument();
    expect(fact(dialog, "Status code")).toHaveTextContent(/^200$/);
    expect(fact(dialog, "Client")).toHaveTextContent(/^Anthropic API$/);
    expect(fact(dialog, "Credits")).toHaveTextContent(/^0\.05$/);
    expect(fact(dialog, "Output")).toHaveTextContent("300150 tok/s");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Enter on a focused row, as on Requests.
    bodyRows(table)[0].focus();
    await user.keyboard("{Enter}");
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "claude-model-0" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Previous request" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // A narrow row opens it too.
    const open = screen.getAllByRole("button", { name: /^Request details, / });
    expect(open).toHaveLength(10);
    await user.click(open[1]);
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "claude-model-1" }),
    ).toBeInTheDocument();
    expect(adminCalls).toEqual([]);
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
      // Under the time below a 72rem card, and in the Error column's pill above it with the
      // status (there is no HTTP column); never a message.
      expect(within(row).getByText("Rate limited")).toBeInTheDocument();
      expect(within(row).getByText("Rate limited · 429")).toBeInTheDocument();
      expect(row.querySelector("[data-slot=http-status]")).toBeNull();
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
    expect(screen.getByRole("tab", { name: /^All/ })).toHaveFocus();
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

  it("goes to the key sign-in page, which says the session expired, when it expires", async () => {
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
    const notice = await screen.findByText("Your session expired. Sign in again.");
    expect(notice.closest("[role=alert]")).not.toBeNull();
    expect(getUserToken()).toBeNull();
  });
});
