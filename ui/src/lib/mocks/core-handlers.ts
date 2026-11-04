import { type HttpHandler, HttpResponse, http, sse } from "msw";
import { REMOTE_VERSION_URL } from "@/lib/api/system";
import type { AdminEventType, RequestRecord } from "@/lib/api/types";
import { mockDb, mockNowUnix, mockScenario } from "./db";
import { onMockEvent } from "./events";
import { buildModelMix, buildStatus, makeObserveError, makeRequestRecord } from "./fixtures";
import { makeLiveRequest } from "./fixtures-full";
import { apiUrl, jsonError, mockDelay, requireAuth } from "./http";

const SESSION_TTL_MS = 12 * 3600 * 1000;
const TICKET_TTL_MS = 30 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const TICK_MS = 5000;
const LIVE_MODELS = ["claude-sonnet-5", "claude-haiku-4.5", "claude-opus-5", "claude-sonnet-4.6"];

// When the 5th wrong password arrived. Like Go, the lock lasts one minute.
let lockedSince = 0;

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function retryAfterSeconds(): number {
  return Math.max(1, Math.ceil((lockedSince + LOGIN_LOCK_MS - Date.now()) / 1000));
}

const MAX_RECENT_ERRORS = 100;

/** The error event a failed request leaves in the recent-errors ring. */
function errorEvent(record: RequestRecord) {
  return makeObserveError({
    ts: record.ts,
    accountId: record.accountId,
    email: record.email,
    model: record.model || undefined,
    status: record.status,
    message: record.message?.slice(0, 240),
  });
}

/**
 * The full dataset's tick: 0-3 requests drawn like the seeded ones (every endpoint, model, key and
 * error type), so the live tiles, sparklines and heatmap keep moving at the seeded rate.
 */
function appendFullRequests(): void {
  const count = Math.floor(Math.random() * 4);
  if (count === 0 || mockDb.accounts.length === 0) return;
  const now = mockNowUnix();
  let nextId = (mockDb.requests[0]?.id ?? 0) + 1;
  for (let i = 0; i < count; i++) {
    const record = makeLiveRequest(mockDb.accounts, mockDb.apiKeys, now, nextId++);
    mockDb.requests.unshift(record);
    if (!record.success) mockDb.errors.unshift(errorEvent(record));
    const account = mockDb.accounts.find((a) => a.id === record.accountId);
    if (account) {
      account.lastUsed = now;
      account.requestCount += 1;
      if (!record.success) account.errorCount += 1;
      account.totalTokens += record.totalTokens;
      account.totalCredits = Math.round((account.totalCredits + record.credits) * 1e4) / 1e4;
    }
    const key = mockDb.apiKeys.find((k) => k.id === record.apiKeyId);
    if (key) {
      key.lastUsedAt = now;
      key.requestsCount += 1;
      key.tokensUsed += record.totalTokens;
      key.creditsUsed = Math.round((key.creditsUsed + record.credits) * 1e4) / 1e4;
    }
  }
  mockDb.errors.length = Math.min(mockDb.errors.length, MAX_RECENT_ERRORS);
  mockDb.modelMix = buildModelMix(mockDb.requests);
}

/** Adds 0-3 synthetic requests (newest first) so live views move in mock mode. */
function appendSyntheticRequests(): void {
  if (mockScenario() === "full") {
    appendFullRequests();
    return;
  }
  const serving = mockDb.accounts.filter(
    (a) => a.enabled && a.hasToken && (a.banStatus === "" || a.banStatus === "ACTIVE"),
  );
  if (serving.length === 0) return;
  const count = Math.floor(Math.random() * 4);
  const now = mockNowUnix();
  let nextId = mockDb.requests.reduce((max, r) => Math.max(max, r.id ?? 0), 0) + 1;
  for (let i = 0; i < count; i++) {
    const account = serving[Math.floor(Math.random() * serving.length)];
    const model = LIVE_MODELS[Math.floor(Math.random() * LIVE_MODELS.length)];
    const failed = Math.random() < 0.08;
    const inTokens = failed ? 0 : 800 + Math.floor(Math.random() * 30_000);
    const outTokens = failed ? 0 : 40 + Math.floor(Math.random() * 2500);
    const record: RequestRecord = makeRequestRecord({
      id: nextId++,
      ts: now,
      accountId: account.id,
      email: account.email || undefined,
      model,
      inTokens,
      outTokens,
      credits: failed ? 0 : Math.round((inTokens / 100_000 + outTokens / 20_000) * 1e4) / 1e4,
      success: !failed,
      status: failed ? 429 : 200,
      errorType: failed ? "rate_limit" : undefined,
      message: failed ? "ThrottlingException: Too many requests, wait and retry" : undefined,
      endpoint: Math.random() < 0.6 ? "claude" : "openai",
      durationMs: 300 + Math.floor(Math.random() * 9000),
    });
    mockDb.requests.unshift(record);
    if (failed) {
      mockDb.errors.unshift(
        makeObserveError({
          ts: now,
          accountId: account.id,
          email: account.email || undefined,
          model,
          status: 429,
          message: record.message,
        }),
      );
      mockDb.errors.length = Math.min(mockDb.errors.length, 100);
    }
  }
  if (count > 0) mockDb.modelMix = buildModelMix(mockDb.requests);
}

// MSW's sse() needs EventSource when the handler is built. jsdom and Node 22 have none, so in
// tests the stream is not mocked and the events provider stays 'closed'.
function eventsHandlers(): HttpHandler[] {
  if (typeof EventSource === "undefined") return [];
  return [
    sse<Record<AdminEventType, string>>(apiUrl("/events"), ({ client, request }) => {
      const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
      if (!ticket.startsWith("mock-ticket-")) {
        client.error();
        return;
      }
      client.send({ event: "hello", data: "{}" });
      let open = true;
      // Backup events from the handlers, as the Go broadcaster sends them.
      const unsubscribe = onMockEvent((type, payload) => {
        if (open) client.send({ event: type, data: JSON.stringify({ type, payload }) });
      });
      const stop = () => {
        open = false;
        clearInterval(timer);
        unsubscribe();
      };
      const timer = setInterval(() => {
        if (!open || request.signal.aborted) {
          stop();
          return;
        }
        appendSyntheticRequests();
        client.send({ event: "observe_tick", data: JSON.stringify({ type: "observe_tick" }) });
      }, TICK_MS);
      request.signal.addEventListener("abort", stop, { once: true });
      // When the app closes its EventSource (sign-out), MSW cancels the stream and calls
      // client.close(), but the request signal does not abort in the browser worker. Without
      // this, the timer keeps writing to the closed stream and MSW logs an error every tick.
      const close = client.close.bind(client);
      client.close = () => {
        stop();
        close();
      };
    }),
  ];
}

/** Session, first-run, events, status and version handlers. */
export const coreHandlers: HttpHandler[] = [
  http.post(apiUrl("/session"), async ({ request }) => {
    await mockDelay();
    if (mockDb.failedLogins >= LOGIN_FAILURE_LIMIT) {
      if (Date.now() - lockedSince < LOGIN_LOCK_MS) {
        return jsonError(429, "Too many admin password attempts; try again later", undefined, {
          "Retry-After": String(retryAfterSeconds()),
        });
      }
      mockDb.failedLogins = 0;
    }
    const body: unknown = await request.json().catch(() => null);
    const fromBody =
      typeof body === "object" && body !== null ? (body as { password?: unknown }).password : "";
    const password =
      typeof fromBody === "string" && fromBody
        ? fromBody
        : (request.headers.get("X-Admin-Password") ?? "");
    if (!password || password !== mockDb.adminPassword) {
      mockDb.failedLogins += 1;
      if (mockDb.failedLogins >= LOGIN_FAILURE_LIMIT) lockedSince = Date.now();
      return jsonError(401, "Unauthorized");
    }
    // A valid password refunds the failure budget and claims the first-run password.
    mockDb.failedLogins = 0;
    mockDb.firstRunPending = false;
    return HttpResponse.json({
      token: `mock-${randomHex(48)}`,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }),

  http.delete(apiUrl("/session"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ success: true });
  }),

  http.post(apiUrl("/session/ticket"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    return HttpResponse.json({
      ticket: `mock-ticket-${randomHex(32)}`,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
  }),

  http.get(apiUrl("/first-run"), async () => {
    await mockDelay();
    return HttpResponse.json(
      { password: mockDb.firstRunPending ? mockDb.adminPassword : "" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }),

  ...eventsHandlers(),

  http.get(apiUrl("/status"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(buildStatus(mockDb));
  }),

  http.get(apiUrl("/version"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    return HttpResponse.json({ version: `v${mockDb.version}` });
  }),

  // The update check answers with the running version (small and empty datasets), so no update
  // notice appears in tests, screenshots or axe runs; the full dataset announces a newer one.
  // MSW matches without the ?t= cache buster.
  http.get(REMOTE_VERSION_URL, () =>
    HttpResponse.json({
      ...mockDb.remoteVersion,
      download: "https://github.com/tanu360/kiro-reverse-api/releases/latest",
    }),
  ),

  http.get(apiUrl("/generate-machine-id"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    return HttpResponse.json({ machineId: crypto.randomUUID() });
  }),
];
