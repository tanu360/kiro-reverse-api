import { type HttpHandler, HttpResponse, http, sse } from "msw";
import { REMOTE_VERSION_URL } from "@/lib/api/system";
import type { AdminEventType, RequestRecord } from "@/lib/api/types";
import { claimMockPassword, mockDb, mockNowUnix, mockScenario } from "./db";
import { onMockEvent } from "./events";
import {
  buildAvailability,
  buildModelMix,
  buildStatus,
  makeObserveError,
  makeRequestRecord,
} from "./fixtures";
import { makeLiveRequest } from "./fixtures-full";
import { apiUrl, jsonError, mockDelay, requireAuth } from "./http";
import { MOCK_TOTP_QR_SVG, MOCK_TOTP_SECRET, MOCK_TOTP_URI, totpMatch } from "./totp";

const SESSION_TTL_MS = (import.meta.env.VITE_MOCK === "1" ? 30 * 24 : 12) * 3600 * 1000;
const TICKET_TTL_MS = 30 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
/** Like Go's backgroundObserveTick: the stream checks for observe changes once a second. */
const TICK_MS = 1000;
/**
 * Synthetic traffic lands every 20 s, not on every check, so the overview's other refresh paths
 * (minute rollover, account and settings events) are what keep it current between bursts.
 */
const TRAFFIC_EVERY_TICKS = 20;
/** Go's observeMinuteSlots: traffic this many minutes back still moves on screen. */
const OBSERVE_MINUTE_SLOTS = 1440;
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

/** The shared guess budget (adminGuessLimiter): a 429 while it is spent, else null. */
function guessLimited(message: string): Response | null {
  if (mockDb.failedLogins < LOGIN_FAILURE_LIMIT) return null;
  if (Date.now() - lockedSince < LOGIN_LOCK_MS) {
    return jsonError(429, message, undefined, { "Retry-After": String(retryAfterSeconds()) });
  }
  mockDb.failedLogins = 0;
  return null;
}

function wrongGuess(): void {
  mockDb.failedLogins += 1;
  if (mockDb.failedLogins >= LOGIN_FAILURE_LIMIT) lockedSince = Date.now();
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TRIES = 5;
const SETUP_TTL_MS = 10 * 60 * 1000;

/** "k7xq2-m9fd4": ten letters and digits in two groups, like newRecoveryCodes. */
function recoveryCodes(): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 10 }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
    return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
  });
}

const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A code or a recovery code (checkSecondFactor): a wrong one uses a guess, a code is good once,
 * a recovery code is used up. Null when it passed, else the error response: 401 at sign-in,
 * 403 for a signed-in admin (a 401 would end the session in the UI).
 */
async function checkSecondFactor(
  code: unknown,
  recoveryCode: unknown,
  failStatus = 401,
): Promise<Response | null> {
  const limited = guessLimited("Too many two-factor attempts; try again later");
  if (limited) return limited;
  const tf = mockDb.twoFactor;
  if (typeof code === "string" && code.trim()) {
    const step = await totpMatch(tf.secret, code);
    if (step !== null && step > tf.lastStep) {
      tf.lastStep = step;
      return null;
    }
    wrongGuess();
    return step !== null
      ? jsonError(failStatus, "This two-factor code was used already; wait for the next one", {
          code: "totp_reused",
        })
      : jsonError(failStatus, "Invalid two-factor code", { code: "totp_invalid" });
  }
  if (typeof recoveryCode === "string" && recoveryCode.trim()) {
    const wanted = normalizeRecovery(recoveryCode);
    const index = tf.recovery.findIndex((item) => normalizeRecovery(item) === wanted);
    if (index >= 0) {
      tf.recovery.splice(index, 1);
      return null;
    }
  }
  wrongGuess();
  return jsonError(failStatus, "Invalid two-factor code", { code: "totp_invalid" });
}

function issueSession(): Response {
  claimMockPassword();
  return HttpResponse.json({
    token: `mock-${randomHex(48)}`,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

function twoFactorStatus() {
  const tf = mockDb.twoFactor;
  return {
    enabled: tf.enabled,
    ...(tf.enabled ? { enabledAt: tf.enabledAt } : {}),
    recoveryCodesLeft: tf.enabled ? tf.recovery.length : 0,
    resetByEnv: tf.resetByEnv,
  };
}

type Json = Record<string, unknown>;

async function readJson(request: Request): Promise<Json> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Json) : {};
}

/** POST /two-factor/... as proxy/admin_totp.go. */
function twoFactorHandlers(): HttpHandler[] {
  return [
    http.get(apiUrl("/two-factor"), async ({ request }) => {
      const denied = requireAuth(request);
      if (denied) return denied;
      await mockDelay();
      return HttpResponse.json(twoFactorStatus());
    }),

    http.post(apiUrl("/two-factor/setup"), async ({ request }) => {
      const denied = requireAuth(request);
      if (denied) return denied;
      await mockDelay();
      const tf = mockDb.twoFactor;
      if (tf.enabled) {
        return jsonError(409, "two-factor sign-in is already on", {
          code: "totp_already_enabled",
        });
      }
      if (tf.resetByEnv) {
        return jsonError(409, "ADMIN_RESET_2FA is set", { code: "totp_reset_by_env" });
      }
      tf.pendingUntil = Date.now() + SETUP_TTL_MS;
      return HttpResponse.json({
        secret: MOCK_TOTP_SECRET,
        otpauthUrl: MOCK_TOTP_URI,
        qrSvg: MOCK_TOTP_QR_SVG,
        issuer: "Kiro Proxy",
        account: "Administrator",
        expiresAt: tf.pendingUntil,
      });
    }),

    http.post(apiUrl("/two-factor/enable"), async ({ request }) => {
      const denied = requireAuth(request);
      if (denied) return denied;
      await mockDelay();
      const body = await readJson(request);
      const tf = mockDb.twoFactor;
      if (tf.enabled) {
        return jsonError(409, "two-factor sign-in is already on", {
          code: "totp_already_enabled",
        });
      }
      if (!tf.pendingUntil || Date.now() > tf.pendingUntil) {
        return jsonError(400, "the setup expired; start it again", { code: "totp_setup_expired" });
      }
      const limited = guessLimited("Too many two-factor attempts; try again later");
      if (limited) return limited;
      const step =
        typeof body.code === "string" ? await totpMatch(MOCK_TOTP_SECRET, body.code) : null;
      if (step === null) {
        wrongGuess();
        return jsonError(400, "Invalid two-factor code", { code: "totp_invalid" });
      }
      const codes = recoveryCodes();
      Object.assign(tf, {
        enabled: true,
        enabledAt: Date.now(),
        secret: MOCK_TOTP_SECRET,
        recovery: [...codes],
        lastStep: step,
        pendingUntil: 0,
      });
      return HttpResponse.json({ status: twoFactorStatus(), recoveryCodes: codes });
    }),

    http.post(apiUrl("/two-factor/disable"), async ({ request }) => {
      const denied = requireAuth(request);
      if (denied) return denied;
      await mockDelay();
      const body = await readJson(request);
      const tf = mockDb.twoFactor;
      if (!tf.enabled) {
        return jsonError(409, "two-factor sign-in is off", { code: "totp_not_enabled" });
      }
      if (body.code || body.recoveryCode) {
        const failed = await checkSecondFactor(body.code, body.recoveryCode, 403);
        if (failed) return failed;
      } else if (typeof body.password === "string" && body.password) {
        const limited = guessLimited("Too many admin password attempts; try again later");
        if (limited) return limited;
        if (body.password !== mockDb.adminPassword) {
          wrongGuess();
          return jsonError(403, "the admin password is not right", {
            code: "admin_password_wrong",
          });
        }
      } else {
        return jsonError(400, "send a current two-factor code or the admin password", {
          code: "totp_proof_required",
        });
      }
      Object.assign(tf, { enabled: false, enabledAt: 0, secret: "", recovery: [], lastStep: 0 });
      tf.challenges = {};
      return HttpResponse.json(twoFactorStatus());
    }),

    http.post(apiUrl("/two-factor/recovery-codes"), async ({ request }) => {
      const denied = requireAuth(request);
      if (denied) return denied;
      await mockDelay();
      const body = await readJson(request);
      const tf = mockDb.twoFactor;
      if (!tf.enabled) {
        return jsonError(409, "two-factor sign-in is off", { code: "totp_not_enabled" });
      }
      if (!body.code) {
        return jsonError(400, "send a current two-factor code", { code: "totp_proof_required" });
      }
      const failed = await checkSecondFactor(body.code, undefined, 403);
      if (failed) return failed;
      const codes = recoveryCodes();
      tf.recovery = [...codes];
      return HttpResponse.json({ status: twoFactorStatus(), recoveryCodes: codes });
    }),
  ];
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
function appendFullRequests(): number {
  const count = Math.floor(Math.random() * 4);
  if (count === 0 || mockDb.accounts.length === 0) return 0;
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
  mockDb.modelMix = buildModelMix(mockDb.requests, mockDb.errors);
  return count;
}

/** Adds 0-3 synthetic requests (newest first) so live views move in mock mode; returns how many. */
function appendSyntheticRequests(): number {
  if (mockScenario() === "full") return appendFullRequests();
  const serving = mockDb.accounts.filter(
    (a) => a.enabled && a.hasToken && (a.banStatus === "" || a.banStatus === "ACTIVE"),
  );
  if (serving.length === 0) return 0;
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
  if (count > 0) mockDb.modelMix = buildModelMix(mockDb.requests, mockDb.errors);
  return count;
}

// The observe store's change counter, as Go's observe_tick payload carries it.
let observeSeq = 0;

/** Go's observeTickState: the minute and account counts the counter last reflected. */
let tickState: { minute: number; enabled: number; available: number } | null = null;

function availabilityNow(): { enabledAccts: number; availableAccts: number } {
  return buildAvailability(mockDb.accounts, mockDb.settings.allowOverUsage);
}

/**
 * Go's observeTickState.advance: moves the counter when a minute ends while the last 24 h hold
 * traffic (every window shifts), or when the enabled or available account count changes.
 */
function advanceObserveSeq(): void {
  const now = mockNowUnix();
  const minute = Math.floor(now / 60);
  const { enabledAccts, availableAccts } = availabilityNow();
  if (!tickState) {
    tickState = { minute, enabled: enabledAccts, available: availableAccts };
    return;
  }
  if (minute !== tickState.minute) {
    tickState.minute = minute;
    const since = (minute - OBSERVE_MINUTE_SLOTS) * 60;
    if (mockDb.requests.some((r) => r.ts >= since)) observeSeq += 1;
  }
  if (enabledAccts !== tickState.enabled || availableAccts !== tickState.available) {
    tickState.enabled = enabledAccts;
    tickState.available = availableAccts;
    observeSeq += 1;
  }
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
      // The counter this stream last sent; like Go, a new stream hears only later changes.
      advanceObserveSeq();
      let sentSeq = observeSeq;
      let ticks = 0;
      const timer = setInterval(() => {
        if (!open || request.signal.aborted) {
          stop();
          return;
        }
        ticks += 1;
        if (ticks % TRAFFIC_EVERY_TICKS === 0 && appendSyntheticRequests() > 0) observeSeq += 1;
        advanceObserveSeq();
        // Like Go: a tick only when observe data changed, carrying the change counter.
        if (observeSeq === sentSeq) return;
        sentSeq = observeSeq;
        client.send({
          event: "observe_tick",
          data: JSON.stringify({ type: "observe_tick", payload: String(observeSeq) }),
        });
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
    const body = await readJson(request);
    const tf = mockDb.twoFactor;
    // The code step: the challenge from the password step, with a code or a recovery code.
    if (typeof body.challenge === "string" && body.challenge) {
      const challenge = tf.challenges[body.challenge];
      if (!tf.enabled || !challenge || Date.now() > challenge.expiresAt) {
        delete tf.challenges[body.challenge];
        return jsonError(401, "The sign-in expired; enter the password again", {
          code: "totp_challenge_expired",
        });
      }
      const failed = await checkSecondFactor(body.code, body.recoveryCode);
      if (failed) {
        challenge.failures += 1;
        if (challenge.failures >= CHALLENGE_TRIES) delete tf.challenges[body.challenge];
        return failed;
      }
      delete tf.challenges[body.challenge];
      return issueSession();
    }
    const limited = guessLimited("Too many admin password attempts; try again later");
    if (limited) return limited;
    const password =
      typeof body.password === "string" && body.password
        ? body.password
        : (request.headers.get("X-Admin-Password") ?? "");
    if (!password || password !== mockDb.adminPassword) {
      wrongGuess();
      return jsonError(401, "Unauthorized");
    }
    // A valid password refunds the failure budget and claims the first-run password.
    mockDb.failedLogins = 0;
    if (tf.enabled) {
      if (body.code || body.recoveryCode) {
        const failed = await checkSecondFactor(body.code, body.recoveryCode);
        return failed ?? issueSession();
      }
      const challenge = randomHex(64);
      const expiresAt = Date.now() + CHALLENGE_TTL_MS;
      tf.challenges[challenge] = { expiresAt, failures: 0 };
      return HttpResponse.json({ twoFactorRequired: true, challenge, expiresAt });
    }
    return issueSession();
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

  ...twoFactorHandlers(),

  http.get(apiUrl("/status"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(buildStatus(mockDb));
  }),

  http.get(apiUrl("/version"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    return HttpResponse.json({
      version: `v${mockDb.version}`,
      os: "linux",
      arch: "amd64",
      docker: true,
    });
  }),

  // The update check answers with the running version (small and empty datasets), so no update
  // notice appears in tests, screenshots or axe runs; the full dataset announces a newer one.
  // MSW matches without the ?t= cache buster.
  http.get(REMOTE_VERSION_URL, () =>
    HttpResponse.json({
      ...mockDb.remoteVersion,
      // Like the real version.json: the latest release page (the release list until there is one).
      download: "https://github.com/tanu360/kiro-reverse-api/releases/latest",
    }),
  ),

  http.get(apiUrl("/generate-machine-id"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    return HttpResponse.json({ machineId: crypto.randomUUID() });
  }),
];
