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
  };
}

/** GET /user/api/requests over 23 requests (every fifth failed); records each query. */
function serveRequests(): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  const all = Array.from({ length: 23 }, (_, index) => request(index));
  mockServer.use(
    http.get(`${USER_API_BASE}/requests`, ({ request: req }) => {
      const params = new URL(req.url).searchParams;
      seen.push(params);
      const status = params.get("status");
      const page = Number(params.get("page"));
      const pageSize = Number(params.get("pageSize"));
      const rows =
        status === "error"
          ? all.filter((row) => !row.success)
          : status === "success"
            ? all.filter((row) => row.success)
            : all;
      return HttpResponse.json({
        requests: rows.slice((page - 1) * pageSize, page * pageSize),
        total: rows.length,
        page,
        pageSize,
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

  it("shows the key's limits, rate limit, models and dates", async () => {
    await signIn({ rpmLimit: 60, allowedModels: ["claude-sonnet-4.5", "claude-opus-4.8"] });
    await renderPanel();
    const limits = screen.getByRole("region", { name: "Limits" });
    expect(within(limits).getByText("1,874,210 / 2,000,000")).toBeInTheDocument();
    expect(within(limits).getByText("46.20 / 50.00")).toBeInTheDocument();
    const details = screen.getByRole("region", { name: "Key details" });
    expect(within(details).getByText("60/min")).toBeInTheDocument();
    expect(within(details).getByText(/claude-sonnet-4\.5.+claude-opus-4\.8/)).toBeInTheDocument();
    expect(within(details).getByText("Never")).toBeInTheDocument();
    // A key limited to models asks for the first of them in the example request.
    const example = screen.getByRole("region", { name: "Example request" });
    const code = example.querySelector("pre")?.textContent ?? "";
    expect(code).toContain('"model": "claude-sonnet-4.5"');
    expect(code).toContain('-H "x-api-key: YOUR_API_KEY"');
  });

  it("reads All models for a key without a model list", async () => {
    await signIn({ allowedModels: [] });
    await renderPanel();
    const details = screen.getByRole("region", { name: "Key details" });
    expect(within(details).getByText("All models")).toBeInTheDocument();
  });

  it("filters the requests by status and pages through them", async () => {
    const seen = serveRequests();
    await signIn();
    const { user } = await renderPanel();
    const table = await requestsTable();
    expect(bodyRows(table)).toHaveLength(10);
    expect(within(table).getByText("1h 15m")).toBeInTheDocument();
    expect(screen.getByText("1–10 of 23")).toBeInTheDocument();
    expect(seen.at(-1)?.get("status")).toBe("all");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("11–20 of 23")).toBeInTheDocument());
    expect(seen.at(-1)?.get("page")).toBe("2");

    // A new filter starts on page 1.
    await user.click(screen.getByRole("tab", { name: "Failed" }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(4));
    expect(seen.at(-1)?.get("status")).toBe("error");
    expect(seen.at(-1)?.get("page")).toBe("1");
    for (const row of bodyRows(table)) {
      expect(within(row).getByText("Failed 429")).toBeInTheDocument();
      expect(within(row).getByText("Rate limited")).toBeInTheDocument();
    }
    // Four requests fit one page: no pager.
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Succeeded" }));
    await waitFor(() => expect(seen.at(-1)?.get("status")).toBe("success"));
    await waitFor(() => expect(screen.getByText("1–10 of 19")).toBeInTheDocument());
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
    await user.click(screen.getByRole("tab", { name: "Failed" }));
    await user.click(await screen.findByRole("button", { name: "Show all requests" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true"),
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
