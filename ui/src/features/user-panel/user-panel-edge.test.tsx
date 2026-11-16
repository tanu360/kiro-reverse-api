import { act, screen, waitFor, within } from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_API_BASE } from "@/lib/api/user-panel";
import { getUserToken, setUserToken, USER_TOKEN_KEY } from "@/lib/auth/user-session";
import { jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { queryClient } from "@/lib/query-client";
import { toast } from "@/lib/toast";
import { renderApp } from "@/test/render";

// The panel against answers at the edges: huge and tiny numbers, long and odd text, empty and
// partial data, each endpoint failing alone, and the session ending in another tab. Every
// /user/api answer is a fixture here, so the mock's own keys never matter.

const TOKEN = "t".repeat(64);
const NOW = Math.floor(Date.now() / 1000);

type Body = Record<string, unknown>;
type Resolver = (request: Request) => Response | Promise<Response>;
type Answer = Body | Resolver;

function keyBody(patch: Body = {}): Body {
  return {
    id: "key-1",
    name: "edge",
    keyMasked: "sk-abc****wxyz",
    enabled: true,
    expired: false,
    createdAt: NOW - 30 * 86_400,
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

function totals(patch: Body = {}): Body {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    inTokens: 0,
    outTokens: 0,
    tokens: 0,
    credits: 0,
    ...patch,
  };
}

/** A 24-hour range; `entry` null sends `keys: []` (a range without this key's traffic). */
function usageBody(entry: Body | null = totals(), sum: Body = entry ?? totals()): Body {
  const buckets = Array.from({ length: 24 }, (_, index) => NOW - (23 - index) * 3600);
  return {
    range: "24h",
    bucket: "hour",
    bucketSeconds: 3600,
    tzOffset: 0,
    from: buckets[0],
    to: NOW + 3600,
    nowUnix: NOW,
    buckets,
    totals: sum,
    keys: entry
      ? [{ id: "key-1", kind: "key", totals: entry, series: buckets.map(() => totals()) }]
      : [],
  };
}

function breakdownBody(models: Body[] = []): Body {
  return { ref: "key-1", range: "24h", from: NOW - 86_400, to: NOW, models, accounts: [] };
}

function row(patch: Body = {}): Body {
  return {
    ts: NOW - 60,
    model: "claude-sonnet-4.5",
    endpoint: "claude",
    inTokens: 1000,
    outTokens: 200,
    totalTokens: 1200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: 0.05,
    success: true,
    status: 200,
    durationMs: 1500,
    errorType: "",
    requestId: `req_${Math.random().toString(16).slice(2)}`,
    ...patch,
  };
}

function requestsBody(rows: Body[] = [], total = rows.length): Body {
  return { requests: rows, total, page: 1, pageSize: 10 };
}

function reply(answer: Answer): Resolver {
  return typeof answer === "function" ? answer : () => HttpResponse.json(answer);
}

/** Answers every panel route; each one a body or a resolver. Records the tokens it was sent. */
function serve(
  answers: { key?: Answer; usage?: Answer; breakdown?: Answer; requests?: Answer } = {},
): string[] {
  const tokens: string[] = [];
  const track =
    (answer: Answer) =>
    ({ request }: { request: Request }) => {
      tokens.push(request.headers.get("X-User-Token") ?? "");
      return reply(answer)(request);
    };
  mockServer.use(
    http.get(`${USER_API_BASE}/key`, track(answers.key ?? keyBody())),
    http.get(`${USER_API_BASE}/usage`, track(answers.usage ?? usageBody())),
    http.get(`${USER_API_BASE}/usage/breakdown`, track(answers.breakdown ?? breakdownBody())),
    http.get(`${USER_API_BASE}/requests`, track(answers.requests ?? requestsBody())),
    http.delete(`${USER_API_BASE}/session`, () => new HttpResponse(null, { status: 204 })),
  );
  return tokens;
}

async function renderPanel(heading = "edge", lang?: "en" | "ja" | "vi") {
  setUserToken(TOKEN, false);
  const result = await renderApp("/user", { authed: false, lang });
  await screen.findByRole("heading", { level: 1, name: heading });
  return result;
}

function region(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The table's body rows once the requests have loaded. */
async function tableRows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole("table", { name: "Recent requests" });
  await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(1));
  return within(table).getAllByRole("row").slice(1);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("data at the edges", () => {
  it("wraps a 120-character name, emoji and right-to-left text included", async () => {
    const name = `🔑 مفتاح الإنتاج ${"production-key-".repeat(10)}`.slice(0, 120);
    serve({ key: keyBody({ name }) });
    await renderPanel(name);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(name);
    // A name with no break in it wraps anywhere instead of pushing the page sideways.
    expect(heading).toHaveClass("wrap-anywhere");
  });

  it("titles a key without a name API key", async () => {
    serve({ key: keyBody({ name: "   " }) });
    await renderPanel("API key");
  });

  it("shows counters in the billions in full on the meters and compact on the cards", async () => {
    serve({
      key: keyBody({ tokensUsed: 4_999_999_999, tokenLimit: 10_000_000_000 }),
      usage: usageBody(
        totals({ requests: 1_234_567_890, succeeded: 1_234_567_890, tokens: 2_500_000_000 }),
      ),
    });
    await renderPanel();
    const usage = region("Usage");
    expect(
      within(usage).getByRole("meter", { name: "Tokens used: 4,999,999,999 of 10,000,000,000" }),
    ).toBeInTheDocument();
    expect(within(usage).getByText("5B of 10B")).toBeInTheDocument();
    expect(within(usage).getByText("50% of key limit")).toBeInTheDocument();
    expect(await within(usage).findByText("1,234,567,890")).toBeInTheDocument();
    expect(within(usage).getByText("2.5B")).toBeInTheDocument();
  });

  it("reads a limit of 0 as unlimited, and one used up or overrun as reached", async () => {
    serve({
      key: keyBody({
        tokenLimit: 0,
        tokensUsed: 12,
        creditLimit: 50,
        creditsUsed: 50,
        callLimit: 10,
        successfulCalls: 15,
      }),
    });
    await renderPanel();
    const usage = region("Usage");
    expect(within(usage).getByText("12 since created")).toBeInTheDocument();
    expect(within(usage).getByText("No key limit")).toBeInTheDocument();
    expect(within(usage).getByText("50.00 of 50.00")).toBeInTheDocument();
    expect(within(usage).getByText("Limit reached · 100%")).toBeInTheDocument();
    expect(within(usage).getByText("15 of 10")).toBeInTheDocument();
    expect(within(usage).getByText("Limit reached · 150%")).toBeInTheDocument();
    // The overrun meter (calls, under Requests) stops at full instead of drawing past its track.
    const meters = within(usage).getAllByRole("meter");
    expect(meters).toHaveLength(2);
    expect(meters[0]).toHaveAttribute("aria-valuenow", "10");
  });

  it.each([
    [1, "1/min"],
    [10_000, "10,000/min"],
  ])("shows a rate limit of %i as %s", async (rpmLimit, text) => {
    serve({ key: keyBody({ rpmLimit }) });
    await renderPanel();
    expect(within(region("Key details")).getByText(text)).toBeInTheDocument();
  });

  it("lists one or forty allowed models, an 80-character ID included", async () => {
    const long = `claude-${"x".repeat(73)}`;
    const models = [long, ...Array.from({ length: 39 }, (_, index) => `model-${index}`)];
    serve({ key: keyBody({ allowedModels: models }) });
    await renderPanel();
    const list = within(region("Key details")).getByRole("list", { name: "Allowed models" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(models);
    // A long ID is cut to the strip, with the whole of it as a tooltip.
    expect(within(list).getByText(long)).toHaveClass("truncate");
    const code = region("Client setup").querySelector("pre")?.textContent ?? "";
    expect(code).toContain(`"model": "${long}"`);
  });

  it("shows a credit too small to round as <0.01 and a large one with two decimals", async () => {
    serve({
      key: keyBody({ creditsUsed: 0.000_000_1 }),
      usage: usageBody(totals({ requests: 3, succeeded: 3, credits: 123_456.789 })),
    });
    await renderPanel();
    expect(within(region("Usage")).getByText("<0.01 since created")).toBeInTheDocument();
    expect(await within(region("Usage")).findByText("123,456.79")).toBeInTheDocument();
  });

  it("formats each request duration, error type, endpoint and a missing model", async () => {
    const errorTypes = [
      ["client_closed", "Client disconnected"],
      ["api_key_limit", "API key limit"],
      ["overage", "Overage"],
      ["quota", "Out of credits"],
      ["suspended", "Suspended"],
      ["profile", "Kiro profile"],
      ["proxy", "Proxy error"],
      ["auth", "Authentication"],
      ["stream", "Stream interrupted"],
      ["no_accounts", "No account available"],
      ["invalid_request", "Invalid request"],
      ["rate_limit", "Rate limited"],
      ["timeout", "Timeout"],
      ["upstream", "Upstream error"],
      ["unknown", "Unknown"],
      ["brand_new_type", "Unknown"],
    ] as const;
    const rows = [
      row({ durationMs: 0, requestId: "req_d0" }),
      row({ durationMs: 999, endpoint: "openai", requestId: "req_d1" }),
      row({ durationMs: 59_900, endpoint: "responses", requestId: "req_d2" }),
      row({ durationMs: 7_200_000, endpoint: "grpc", requestId: "req_d3" }),
      row({ model: "", endpoint: "", durationMs: 0, requestId: "req_d4" }),
      ...errorTypes.map(([errorType], index) =>
        row({
          success: false,
          status: 400 + index,
          errorType,
          credits: 0,
          inTokens: 0,
          outTokens: 0,
          totalTokens: 0,
          requestId: `req_e${index}`,
        }),
      ),
    ];
    serve({ requests: () => HttpResponse.json({ ...requestsBody(rows), pageSize: 25 }) });
    await renderPanel();
    const body = await tableRows();
    const cells = (index: number) => within(body[index] as HTMLElement);
    // As on Requests, the duration sits in its own column and, for a narrower card, under the
    // credits: two copies. The caller (here the endpoint's API) rides under the model.
    expect(cells(0).getAllByText("0ms")).toHaveLength(2);
    expect(cells(1).getAllByText("999ms")).toHaveLength(2);
    expect(cells(1).getByText("OpenAI API")).toBeInTheDocument();
    expect(cells(2).getAllByText("59.9s")).toHaveLength(2);
    expect(cells(2).getByText("OpenAI Responses")).toBeInTheDocument();
    expect(cells(3).getAllByText("2h")).toHaveLength(2);
    // An endpoint this UI does not know shows nothing rather than a raw value.
    expect(cells(3).queryByText("grpc")).not.toBeInTheDocument();
    // No model and no endpoint (a row logged before either was): dashes, no "0ms".
    expect(cells(4).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    errorTypes.forEach(([, label], index) => {
      expect(cells(5 + index).getByText(`Failed ${400 + index}`)).toHaveClass("sr-only");
      // Under the time for a narrower card, and in the Error column's pill with the status, as
      // on the admin's table: there is no HTTP column.
      expect(cells(5 + index).getByText(label)).toBeInTheDocument();
      expect(cells(5 + index).getByText(`${label} · ${400 + index}`)).toBeInTheDocument();
      expect(body[5 + index].querySelector("[data-slot=http-status]")).toBeNull();
    });
  });

  it("cuts a long model ID in the table and the cards, as the Requests page does", async () => {
    const long = `claude-${"y".repeat(73)}`;
    serve({ requests: requestsBody([row({ model: long })]) });
    await renderPanel();
    await tableRows();
    const shown = screen.getAllByText(long);
    expect(shown).toHaveLength(2);
    for (const model of shown) expect(model).toHaveClass("truncate");
  });

  it("shows a dash for a request without a time and for a key without a creation date", async () => {
    serve({ key: keyBody({ createdAt: 0 }), requests: requestsBody([row({ ts: 0 })]) });
    await renderPanel();
    const details = region("Key details");
    expect(within(details).queryByText(/1970/)).not.toBeInTheDocument();
    const [first] = await tableRows();
    expect(first).not.toHaveTextContent(/1970|Jan 1/);
  });

  it("reads a last use the browser's clock puts ahead as just now", async () => {
    serve({ key: keyBody({ lastUsedAt: NOW + 120 }) });
    await renderPanel();
    const lastUsed = within(region("Key details")).getByText("Last used").nextElementSibling;
    expect(lastUsed).toHaveTextContent(/^(now|\d+ seconds? ago)$/);
  });

  it("says Never used for a key with no last use", async () => {
    serve({ key: keyBody({ lastUsedAt: 0 }) });
    await renderPanel();
    expect(within(region("Key details")).getByText("Never used")).toBeInTheDocument();
  });
});

describe("empty and partial data", () => {
  it("shows zeros and the empty chart for a range without this key's traffic", async () => {
    serve({ usage: usageBody(null) });
    await renderPanel();
    const usage = region("Usage");
    await waitFor(() => expect(within(usage).getAllByText("0").length).toBeGreaterThan(0));
    expect(within(usage).getByText("0.00")).toBeInTheDocument();
    expect(await screen.findAllByText("No usage in this range")).not.toHaveLength(0);
  });

  it("compares a quiet range with the busy stretch before it, with no failure rate", async () => {
    serve({ usage: { ...usageBody(totals()), previous: totals({ requests: 4, succeeded: 4 }) } });
    await renderPanel();
    const usage = region("Usage");
    await waitFor(() =>
      expect(within(usage).getByText(/vs previous 24 hours/).parentElement).toHaveTextContent(
        "−100% vs previous 24 hours",
      ),
    );
    expect(within(usage).getByText("Nothing failed")).toBeInTheDocument();
    expect(within(usage).queryByText(/\d failed$/)).not.toBeInTheDocument();
  });

  it("says a breakdown without models has no usage", async () => {
    serve({ breakdown: breakdownBody([]) });
    await renderPanel();
    const models = await screen.findByRole("region", { name: "Usage by model" });
    expect(await within(models).findByText("No usage in this range")).toBeInTheDocument();
  });

  it("shows the models as the Overview's model mix: five by requests, the rest counted", async () => {
    const item = (id: string, requests: number, credits: number): Body => ({
      id,
      requests,
      succeeded: requests,
      failed: 0,
      tokens: requests * 100,
      credits,
    });
    serve({
      breakdown: breakdownBody([
        item("m-a", 2, 9),
        item("m-b", 9, 1),
        item("m-c", 7, 1),
        item("m-d", 5, 1),
        item("m-e", 4, 1),
        item("m-f", 3, 1),
        item("", 1, 0),
      ]),
    });
    await renderPanel();
    const card = await screen.findByRole("region", { name: "Usage by model" });
    const table = await within(card).findByRole("table", { name: "Models" });
    // Ranked by requests, not credits: m-a used the most credits but sent only two requests.
    const names = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(names).toEqual(["m-b", "m-c", "m-d", "m-e", "m-f"]);
    expect(within(card).getByRole("figure", { name: "Share of requests by model" })).toBeVisible();
    expect(within(card).getByText("2 more models")).toBeInTheDocument();
  });

  it("offers the first page when a page past the end comes back empty", async () => {
    const all = Array.from({ length: 23 }, (_, index) => row({ requestId: `req_${index}` }));
    // The log is pruned after page 1 loads: page 2 is past the end by the time it is asked for.
    serve({
      requests: (request) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page"));
        const rows = page === 1 ? all.slice(0, 10) : [];
        return HttpResponse.json({ requests: rows, total: 23, page, pageSize: 10 });
      },
    });
    const { user } = await renderPanel();
    await tableRows();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("No requests on this page")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to first page" }));
    await waitFor(() => expect(screen.getByText("1–10 of 23")).toBeInTheDocument());
  });

  it("turns the badge and notice to expired when the expiry passes on an open page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = Math.floor(Date.now() / 1000) + 10;
    serve({ key: keyBody({ expiresAt }) });
    await renderPanel();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    await waitFor(() => expect(screen.getByText("Expired")).toBeInTheDocument());
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/^This key expired on /);
  });
});

describe("one request failing", () => {
  const BUSY = "Too many usage requests for this key. Wait a minute and try again.";
  const busy = () =>
    jsonError(429, "Too many usage requests; try again in a minute", { code: "user_usage_busy" });

  const cases = [
    ["key", "Could not load your API key"],
    ["usage", "Could not load key usage"],
    ["breakdown", "Could not load the breakdown"],
    ["requests", "Could not load requests"],
  ] as const;

  it.each(cases)(
    "shows %s failing with 500 in its own card, with a Try again that works",
    async (route, title) => {
      let fail = true;
      const healthy = {
        key: keyBody(),
        usage: usageBody(),
        breakdown: breakdownBody(),
        requests: requestsBody([row()]),
      }[route];
      serve({
        [route]: () =>
          fail
            ? jsonError(500, "Internal error", { code: "internal_error" })
            : HttpResponse.json(healthy),
      });
      setUserToken(TOKEN, false);
      const { user } = await renderApp("/user", { authed: false });
      const alert = (await screen.findByText(title)).closest("[role=alert]") as HTMLElement;
      expect(alert).not.toBeNull();
      if (route === "key") {
        // No bars left loading over the failure: the heading is the plain title.
        expect(screen.getByRole("heading", { level: 1, name: "API key" })).toBeInTheDocument();
        expect(document.querySelector("[aria-busy=true]")).toBeNull();
      } else {
        // The rest of the page still loads.
        expect(await screen.findByRole("heading", { level: 1, name: "edge" })).toBeInTheDocument();
      }
      if (route === "usage") {
        // The four cards say they did not load instead of staying loading bars.
        expect(within(region("Usage")).getAllByText("Not loaded")).toHaveLength(4);
      }
      fail = false;
      await user.click(within(alert).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.queryByText(title)).not.toBeInTheDocument());
    },
  );

  // Only the usage queries have a per-key budget (proxy/user_api.go).
  const busyCases = [
    ["usage", "Could not load key usage"],
    ["breakdown", "Could not load the breakdown"],
  ] as const;

  it.each(busyCases)(
    "shows %s answering 429 user_usage_busy with the translated reason",
    async (route, title) => {
      let fail = true;
      const healthy = { usage: usageBody(), breakdown: breakdownBody() }[route];
      serve({ [route]: () => (fail ? busy() : HttpResponse.json(healthy)) });
      const { user } = await renderPanel();
      const alert = (await screen.findByText(title)).closest("[role=alert]") as HTMLElement;
      expect(within(alert).getByText(BUSY)).toBeInTheDocument();
      fail = false;
      await user.click(within(alert).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.queryByText(title)).not.toBeInTheDocument());
    },
  );

  it.each(cases)("says %s could not reach the proxy on a network error", async (route, title) => {
    serve({ [route]: () => HttpResponse.error() });
    setUserToken(TOKEN, false);
    await renderApp("/user", { authed: false });
    const alert = (await screen.findByText(title)).closest("[role=alert]") as HTMLElement;
    expect(within(alert).getByText("Could not connect to the proxy.")).toBeInTheDocument();
  });

  it("keeps the heading's place while the key loads slowly", async () => {
    serve({
      key: async () => {
        await delay(150);
        return HttpResponse.json(keyBody());
      },
    });
    setUserToken(TOKEN, false);
    await renderApp("/user", { authed: false });
    const busyHeader = document.querySelector("[aria-busy=true]");
    expect(busyHeader).not.toBeNull();
    // The usage cards and the key facts keep their places, as bars.
    expect(within(region("Usage")).getAllByText(/^(Requests|Failed|Credits|Tokens)$/)).toHaveLength(
      4,
    );
    expect(within(region("Key details")).getAllByRole("term")).toHaveLength(5);
    await screen.findByRole("heading", { level: 1, name: "edge" });
  });

  it.each(["key", "usage", "breakdown", "requests"] as const)(
    "signs out once with one toast when %s alone answers 401",
    async (route) => {
      const warning = vi.spyOn(toast, "warning");
      serve({
        [route]: () => jsonError(401, "Unauthorized", { code: "user_session_expired" }),
      });
      setUserToken(TOKEN, false);
      const { router } = await renderApp("/user", { authed: false });
      await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
      expect(warning).toHaveBeenCalledTimes(1);
      expect(getUserToken()).toBeNull();
      expect(
        await screen.findByRole("heading", { level: 1, name: "Check your API key" }),
      ).toBeVisible();
    },
  );
});

describe("the session in another tab", () => {
  function storageEvent(oldValue: string | null, newValue: string | null): void {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: USER_TOKEN_KEY,
        oldValue,
        newValue,
        storageArea: localStorage,
      }),
    );
  }

  it("goes to the sign-in page, without the expiry toast, when another tab signs out", async () => {
    serve();
    const warning = vi.spyOn(toast, "warning");
    setUserToken(TOKEN, true);
    const { router } = await renderApp("/user", { authed: false });
    await screen.findByRole("heading", { level: 1, name: "edge" });
    // The other tab removes the shared token; this tab only hears the storage event.
    localStorage.removeItem(USER_TOKEN_KEY);
    act(() => storageEvent(TOKEN, null));
    await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
    expect(warning).not.toHaveBeenCalled();
  });

  it("loads the other key when another tab signs in with it", async () => {
    const tokens = serve();
    setUserToken(TOKEN, true);
    // The app's own client: a session change drops the panel's queries from it (user-panel.ts).
    await renderApp("/user", { authed: false, queryClient });
    await screen.findByRole("heading", { level: 1, name: "edge" });
    const other = "o".repeat(64);
    localStorage.setItem(USER_TOKEN_KEY, other);
    act(() => storageEvent(TOKEN, other));
    await waitFor(() => expect(tokens).toContain(other));
  });

  it("ignores another tab's change while this tab keeps its own session-only token", async () => {
    const tokens = serve();
    setUserToken(TOKEN, false);
    const { router } = await renderApp("/user", { authed: false });
    await screen.findByRole("heading", { level: 1, name: "edge" });
    const before = tokens.length;
    localStorage.setItem(USER_TOKEN_KEY, "o".repeat(64));
    act(() => storageEvent(null, "o".repeat(64)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tokens.slice(before)).not.toContain("o".repeat(64));
    expect(router.state.location.pathname).toBe("/user");
  });
});

/** A focused control's name: its aria-label, else its text. */
function accessibleName(element: Element | null): string {
  return element?.getAttribute("aria-label") || element?.textContent?.trim() || "";
}

describe("keyboard and screen readers", () => {
  it("names every button, icon-only ones included", async () => {
    serve({ requests: requestsBody([row()]) });
    await renderPanel();
    await tableRows();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName(/\S/);
    }
  });

  it("starts the tab order at the skip link, then the header, then Refresh", async () => {
    serve();
    const { user } = await renderPanel();
    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Kiro Proxy" })).toHaveFocus();
    // The language and theme menus, then Sign out, then the page's Refresh.
    const order: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await user.tab();
      order.push(accessibleName(document.activeElement));
    }
    expect(order.slice(-2)).toEqual(["Sign out", "Refresh"]);
  });

  it("changes the range with the arrow keys and the status filter from the keyboard", async () => {
    const ranges: string[] = [];
    const statuses: string[] = [];
    serve({
      usage: (request) => {
        ranges.push(new URL(request.url).searchParams.get("range") ?? "");
        return HttpResponse.json(usageBody());
      },
      requests: (request) => {
        statuses.push(new URL(request.url).searchParams.get("status") ?? "");
        return HttpResponse.json(requestsBody([row()]));
      },
    });
    const { user } = await renderPanel();
    await tableRows();
    const range = screen.getByRole("radiogroup", { name: "Time range" });
    within(range).getByRole("radio", { name: "24h" }).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(ranges.at(-1)).toBe("7d"));
    expect(within(range).getByRole("radio", { name: "7d" })).toBeChecked();

    screen.getByRole("tab", { name: "All" }).focus();
    await user.keyboard("{ArrowRight}{Enter}");
    await waitFor(() => expect(statuses.at(-1)).toBe("success"));
    expect(screen.getByRole("tab", { name: "Succeeded" })).toHaveAttribute("aria-selected", "true");
  });
});
