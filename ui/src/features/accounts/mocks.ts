import { type HttpHandler, HttpResponse, http } from "msw";
import type { AccountActivityResponse } from "@/lib/api/account-activity";
import type { DuplicateGroup } from "@/lib/api/duplicates";
import type {
  Account,
  AccountActionResult,
  AccountFull,
  AccountInfo,
  BatchAction,
  BatchTagAction,
  UpdateAccountRequest,
} from "@/lib/api/types";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import {
  makeCachedModelIds,
  makeExport,
  makeModelInfo,
  makeOverage,
  makeProfiles,
  makeTestResult,
} from "@/lib/mocks/fixtures";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";
import { MAX_NOTES, MAX_TAGS, normalizeTag, normalizeTags, tagKey } from "./account-metadata";

// Accounts endpoints over mockDb, with the Go server's semantics (research area-accounts §1).

const BATCH_ACTIONS: readonly BatchAction[] = [
  "enable",
  "disable",
  "refresh",
  "refreshModels",
  "delete",
];
const MAX_PRIORITY = 999;

/** Go parseAccountPriority: a present "priority" must be an integer JSON number 0..999. */
function invalidPriority(body: Record<string, unknown>): boolean {
  if (!("priority" in body)) return false;
  const value = body.priority;
  return !Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_PRIORITY;
}

const TAG_ACTIONS: readonly BatchTagAction[] = ["addTag", "removeTag"];

/** accounts_changed after every account write, as the Go config hook sends it. */
function accountsChanged(id = "*"): void {
  publishMockEvent("accounts_changed", id);
}

/**
 * One result per distinct requested id in request order, like Go's matchAccounts: unknown ids
 * fail with status "not_found", known ones get `act`'s outcome.
 */
function eachRequested(
  ids: string[],
  act: (account: Account) => Omit<AccountActionResult, "id">,
): AccountActionResult[] {
  return [...new Set(ids)].map((id) => {
    const account = findAccount(id);
    if (!account) {
      return {
        id,
        ok: false,
        error: "Account not found",
        code: "account_not_found",
        status: "not_found",
      };
    }
    return { id, ...act(account) };
  });
}

function countOk(results: AccountActionResult[]): { ok: number; failed: number } {
  const ok = results.filter((result) => result.ok).length;
  return { ok, failed: results.length - ok };
}

function findAccount(id: string): Account | undefined {
  return mockDb.accounts.find((account) => account.id === id);
}

function accountId(params: Record<string, string | readonly string[] | undefined>): string {
  const id = params.id;
  return decodeURIComponent(Array.isArray(id) ? (id[0] ?? "") : String(id ?? ""));
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isApiKey(account: Account): boolean {
  return account.authMethod === "api_key" || account.authMethod === "apikey";
}

function isBanned(account: Account): boolean {
  return account.banStatus !== "" && account.banStatus !== "ACTIVE";
}

/** enabled:true on a banned account resets the ban and the silent flags (Go apiUpdateAccount). */
function enableAccount(account: Account): void {
  if (isBanned(account)) {
    account.banStatus = "ACTIVE";
    account.banReason = "";
    account.banTime = 0;
    account.silent = false;
    account.silentReason = "";
    account.silentTime = 0;
  }
  account.enabled = true;
}

/** Only the keys and types the server honours; anything else is ignored. */
function applyUpdate(account: Account, body: Record<string, unknown>): void {
  const patch = body as UpdateAccountRequest;
  if (typeof patch.enabled === "boolean") {
    if (patch.enabled) enableAccount(account);
    else account.enabled = false;
  }
  if (typeof patch.nickname === "string") account.nickname = patch.nickname;
  if (typeof patch.machineId === "string") account.machineId = patch.machineId;
  if (typeof patch.weight === "number") account.weight = Math.trunc(patch.weight);
  if (typeof patch.priority === "number") account.priority = patch.priority;
  if (typeof patch.proxyURL === "string") account.proxyURL = patch.proxyURL;
  // The server normalizes and clamps both (config/account_metadata.go).
  if (typeof patch.notes === "string") {
    account.notes = patch.notes.replace(/\r\n?/g, "\n").trim().slice(0, MAX_NOTES).trim();
  }
  if (Array.isArray(patch.tags)) {
    account.tags = normalizeTags(patch.tags.filter((tag) => typeof tag === "string"));
  }
  if (typeof patch.silent === "boolean") {
    if (patch.silent) {
      account.enabled = false;
      const reason = typeof patch.silentReason === "string" ? patch.silentReason.trim() : "";
      account.silent = true;
      account.silentReason = reason || account.silentReason || "manual";
      if (!account.silentTime) account.silentTime = mockNowUnix();
    } else {
      account.silent = false;
      account.silentReason = "";
      account.silentTime = 0;
    }
  }
}

/** The /full view: the stored secrets over the current list fields. */
function fullAccount(account: Account): AccountFull {
  const { hasToken: _hasToken, activeRegion: _activeRegion, ...fields } = account;
  const secrets: Partial<AccountFull> = mockDb.secrets[account.id] ?? {};
  return {
    ...fields,
    accessToken: secrets.accessToken ?? "",
    refreshToken: secrets.refreshToken ?? "",
    kiroApiKey: secrets.kiroApiKey ?? "",
    clientId: secrets.clientId ?? "",
    clientSecret: secrets.clientSecret ?? "",
    tokenEndpoint: secrets.tokenEndpoint ?? "",
    issuerUrl: secrets.issuerUrl ?? "",
    scopes: secrets.scopes ?? "",
  };
}

function accountInfo(account: Account): AccountInfo {
  return {
    Email: account.email,
    UserId: account.userId,
    SubscriptionType: account.subscriptionType,
    SubscriptionTitle: account.subscriptionTitle,
    DaysRemaining: account.daysRemaining,
    UsageCurrent: account.usageCurrent,
    UsageLimit: account.usageLimit,
    UsagePercent: account.usagePercent,
    NextResetDate: account.nextResetDate,
    LastRefresh: account.lastRefresh,
    TrialUsageCurrent: account.trialUsageCurrent,
    TrialUsageLimit: account.trialUsageLimit,
    TrialUsagePercent: account.trialUsagePercent,
    TrialStatus: account.trialStatus,
    TrialExpiresAt: account.trialExpiresAt,
  };
}

/** The live model list: the catalog plus `auto`, in server order. */
function liveModels() {
  return [
    ...makeCachedModelIds().map((modelId) => makeModelInfo({ modelId })),
    makeModelInfo({
      modelId: "auto",
      modelName: "Auto",
      description: "Kiro picks a model per request",
      rateMultiplier: 1,
    }),
  ];
}

/**
 * GET /observe/account-activity over the request log: final requests since local midnight and
 * in the last 60 s per account. The mock has no pool, so "at limit" is the live RPM reaching it.
 */
function accountActivity(): AccountActivityResponse {
  const now = mockNowUnix();
  const midnight = new Date(now * 1000);
  midnight.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(midnight.getTime() / 1000);
  const limit = mockDb.settings.accountRpmLimit ?? 0;
  const accounts: AccountActivityResponse["accounts"] = {};
  for (const account of mockDb.accounts) {
    accounts[account.id] = { today: 0, rpm: 0, atLimit: false };
  }
  for (const record of mockDb.requests) {
    const row = accounts[record.accountId];
    if (!row || record.ts > now) continue;
    if (record.ts >= dayStart) row.today += 1;
    if (record.ts > now - 60) row.rpm += 1;
  }
  for (const row of Object.values(accounts)) row.atLimit = limit > 0 && row.rpm >= limit;
  return { nowUnix: now, dayStartUnix: dayStart, rpmLimit: limit, accounts };
}

/**
 * The mock's duplicate groups: one Kiro user is the same provider, sign-in method and email
 * (the Go rule set also matches refresh tokens, user ids and API keys, which mockDb lacks). The
 * seeded accounts have none, so the list is empty until a test adds a copy.
 */
function duplicateGroups(): DuplicateGroup[] {
  const byUser = new Map<string, Account[]>();
  for (const account of mockDb.accounts) {
    const email = account.email.trim().toLowerCase();
    if (!email || isApiKey(account)) continue;
    const key = [account.provider.toLowerCase(), account.authMethod.toLowerCase(), email].join("|");
    byUser.set(key, [...(byUser.get(key) ?? []), account]);
  }
  return [...byUser.values()]
    .filter((accounts) => accounts.length > 1)
    .map((accounts) => {
      const healthy = (account: Account) =>
        account.enabled && !account.silent && !isBanned(account) && account.hasToken;
      const keeper = [...accounts].sort(
        (a, b) =>
          Number(healthy(b)) - Number(healthy(a)) ||
          b.lastRefresh - a.lastRefresh ||
          b.expiresAt - a.expiresAt,
      )[0];
      return {
        reasons: ["email"],
        suggestedKeepId: keeper?.id ?? "",
        accounts: accounts.map((account) => ({
          id: account.id,
          email: account.email,
          nickname: account.nickname,
          authMethod: account.authMethod,
          provider: account.provider,
          region: account.region,
          enabled: account.enabled,
          healthy: healthy(account),
          banStatus: account.banStatus,
          silent: account.silent,
          lastRefresh: account.lastRefresh,
          expiresAt: account.expiresAt,
          lastUsed: account.lastUsed,
          requestCount: account.requestCount,
          errorCount: account.errorCount,
        })),
      };
    });
}

export const handlers: HttpHandler[] = [
  http.get(apiUrl("/accounts"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(mockDb.accounts);
  }),

  http.get(apiUrl("/observe/account-activity"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(accountActivity());
  }),

  http.post(apiUrl("/accounts/batch"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    if (ids.length === 0) return jsonError(400, "No account IDs provided");
    const tagAction = body.action as BatchTagAction;
    if (TAG_ACTIONS.includes(tagAction)) {
      const tag = normalizeTag(typeof body.tag === "string" ? body.tag : "");
      if (!tag) return jsonError(400, "tag is required");
      await mockDelay();
      const results = eachRequested(ids, (account) => {
        const has = account.tags.some((existing) => tagKey(existing) === tagKey(tag));
        if (tagAction === "removeTag") {
          account.tags = account.tags.filter((existing) => tagKey(existing) !== tagKey(tag));
          return { ok: true };
        }
        if (has) return { ok: true };
        if (account.tags.length >= MAX_TAGS) {
          return { ok: false, error: `Account already has ${MAX_TAGS} tags`, status: "tag_limit" };
        }
        account.tags = [...account.tags, tag];
        return { ok: true };
      });
      accountsChanged();
      const { ok, failed } = countOk(results);
      return HttpResponse.json({ success: true, count: ok, failed, results });
    }
    const action = body.action as BatchAction;
    if (!BATCH_ACTIONS.includes(action)) return jsonError(400, `Invalid action: ${body.action}`);
    await mockDelay();
    if (action === "enable" || action === "disable") {
      const results = eachRequested(ids, (account) => {
        if (action === "enable") {
          enableAccount(account);
          account.silent = false;
          account.silentReason = "";
          account.silentTime = 0;
        } else {
          account.enabled = false;
        }
        return { ok: true };
      });
      accountsChanged();
      const { ok, failed } = countOk(results);
      return HttpResponse.json({ success: true, count: ok, failed, results });
    }
    if (action === "refresh") {
      const results = eachRequested(ids, (account) => {
        // The suspended branch marks the account instead of failing it.
        if (account.banStatus === "SUSPENDED") {
          account.enabled = false;
          return { ok: true, status: "suspended" };
        }
        account.lastRefresh = mockNowUnix();
        return { ok: true };
      });
      accountsChanged();
      const suspended = results.filter((result) => result.status === "suspended").length;
      const { ok, failed } = countOk(results);
      return HttpResponse.json({
        success: true,
        refreshed: ok - suspended,
        suspended,
        failed,
        results,
      });
    }
    if (action === "refreshModels") {
      const results = eachRequested(ids, () => ({ ok: true }));
      const { ok, failed } = countOk(results);
      return HttpResponse.json({
        success: true,
        refreshed: ok,
        failed,
        models: liveModels().length,
        results,
      });
    }
    const results = eachRequested(ids, (account) => {
      mockDb.accounts = mockDb.accounts.filter((row) => row.id !== account.id);
      delete mockDb.secrets[account.id];
      return { ok: true };
    });
    accountsChanged();
    const { ok, failed } = countOk(results);
    return HttpResponse.json({ success: true, deleted: ok, failed, results });
  }),

  // Registered before /accounts/:id/... so "duplicates" is never read as an account id.
  http.get(apiUrl("/accounts/duplicates"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const groups = duplicateGroups();
    return HttpResponse.json({
      duplicateCount: groups.reduce((sum, group) => sum + group.accounts.length - 1, 0),
      groups,
    });
  }),

  http.post(apiUrl("/accounts/duplicates/merge"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON", { code: "invalid_json" });
    const keepId = typeof body.keepId === "string" ? body.keepId : "";
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === "string" && id !== keepId)
      : [];
    const removed = [...new Set(ids)];
    if (!keepId || removed.length === 0) {
      return jsonError(400, "ids must name at least one account besides keepId", {
        code: "no_account_ids",
      });
    }
    await mockDelay();
    const group = duplicateGroups().find((candidate) =>
      candidate.accounts.some((account) => account.id === keepId),
    );
    const members = new Set(group?.accounts.map((account) => account.id));
    if (!group || removed.some((id) => !members.has(id))) {
      return jsonError(
        409,
        "These accounts are no longer duplicates of each other. Review the duplicates again.",
        { code: "duplicates_changed" },
      );
    }
    const kept = findAccount(keepId);
    for (const id of removed) {
      const donor = findAccount(id);
      if (kept && donor) {
        kept.requestCount += donor.requestCount;
        kept.errorCount += donor.errorCount;
        kept.totalTokens += donor.totalTokens;
        kept.totalCredits += donor.totalCredits;
        kept.lastUsed = Math.max(kept.lastUsed, donor.lastUsed);
      }
    }
    mockDb.accounts = mockDb.accounts.filter((account) => !removed.includes(account.id));
    accountsChanged(keepId);
    return HttpResponse.json({ success: true, keptId: keepId, removed, requestsMoved: 0 });
  }),

  // Registered before /accounts/:id/... so "models" is never read as an account id.
  http.post(apiUrl("/accounts/models/refresh"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    // One sweep over the enabled accounts; `refreshed` and `failed` count accounts.
    const results: AccountActionResult[] = mockDb.accounts
      .filter((account) => account.enabled)
      .map((account) => ({ id: account.id, ok: true }));
    return HttpResponse.json({
      success: true,
      accounts: results.length,
      refreshed: results.length,
      failed: 0,
      models: liveModels().length,
      results,
    });
  }),

  http.post(apiUrl("/accounts/:id/models/refresh"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    if (!findAccount(accountId(params))) return jsonError(404, "Account not found");
    await mockDelay();
    return HttpResponse.json({ success: true, count: liveModels().length });
  }),

  http.post(apiUrl("/accounts/:id/refresh"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    await mockDelay();
    // The suspended branch marks the account and answers without `info`.
    if (account.banStatus === "SUSPENDED") {
      account.enabled = false;
      accountsChanged(account.id);
      return HttpResponse.json({ success: true, message: "Account status updated" });
    }
    account.lastRefresh = mockNowUnix();
    accountsChanged(account.id);
    return HttpResponse.json({ success: true, info: accountInfo(account) });
  }),

  http.post(apiUrl("/accounts/:id/test"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    const body = await readJson(request);
    await mockDelay();
    if (account.banStatus === "BANNED") {
      return jsonError(500, "AccessDeniedException: account access has been revoked (403)");
    }
    const model = typeof body?.model === "string" && body.model ? body.model : "claude-sonnet-5";
    return HttpResponse.json(makeTestResult(model));
  }),

  http.get(apiUrl("/accounts/:id/models/cached"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    // Never 404s; the server iterates a set, so the order is not sorted.
    const models = findAccount(accountId(params)) ? [...makeCachedModelIds()].reverse() : [];
    return HttpResponse.json({ success: true, models });
  }),

  http.get(apiUrl("/accounts/:id/models"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    if (!findAccount(accountId(params))) return jsonError(404, "Account not found");
    await mockDelay();
    return HttpResponse.json({ success: true, models: liveModels() });
  }),

  http.get(apiUrl("/accounts/:id/overage"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    await mockDelay();
    const snapshot = makeOverage(account);
    account.overageCheckedAt = snapshot.overageCheckedAt;
    return HttpResponse.json(snapshot);
  }),

  http.post(apiUrl("/accounts/:id/overage"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    if (!body || typeof body.enabled !== "boolean") return jsonError(400, "Invalid JSON");
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    if (body.enabled && account.overageCapability.toUpperCase() === "NOT_OVERAGE_CAPABLE") {
      return jsonError(400, "Account is not overage capable");
    }
    await mockDelay();
    account.overageStatus = body.enabled ? "ENABLED" : "DISABLED";
    const snapshot = makeOverage(account);
    account.overageCheckedAt = snapshot.overageCheckedAt;
    return HttpResponse.json(snapshot);
  }),

  http.get(apiUrl("/accounts/:id/profiles"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    if (isApiKey(account)) {
      return jsonError(400, "API key accounts have no Kiro profile; their region is set at import");
    }
    await mockDelay();
    return HttpResponse.json({
      success: true,
      profiles: makeProfiles(account),
      currentArn: account.profileArn,
      activeRegion: account.activeRegion,
      pinned: account.profileArnPinned,
    });
  }),

  http.post(apiUrl("/accounts/:id/profile"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    if (isApiKey(account)) {
      return jsonError(400, "API key accounts have no Kiro profile; their region is set at import");
    }
    await mockDelay();
    const arn = typeof body.profileArn === "string" ? body.profileArn.trim() : "";
    if (!arn) {
      account.profileArnPinned = false;
      return HttpResponse.json({ success: true, pinned: false });
    }
    if (!arn.startsWith("arn:aws:codewhisperer:")) return jsonError(400, "profileArn is invalid");
    const profile = makeProfiles(account).find((candidate) => candidate.arn === arn);
    if (!profile) return jsonError(400, "Selected Kiro profile is not available for this account");
    account.profileArn = profile.arn;
    account.profileArnPinned = true;
    account.activeRegion = profile.region;
    return HttpResponse.json({
      success: true,
      pinned: true,
      profileArn: profile.arn,
      region: profile.region,
    });
  }),

  http.get(apiUrl("/accounts/:id/full"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    await mockDelay();
    return HttpResponse.json(fullAccount(account));
  }),

  http.put(apiUrl("/accounts/:id"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    if (invalidPriority(body)) {
      return jsonError(400, `priority must be an integer between 0 and ${MAX_PRIORITY}`, {
        code: "priority_range",
      });
    }
    const account = findAccount(accountId(params));
    if (!account) return jsonError(404, "Account not found");
    await mockDelay();
    applyUpdate(account, body);
    accountsChanged(account.id);
    return HttpResponse.json({ success: true });
  }),

  // Unknown ids also answer 200 (config.DeleteAccount returns nil when not found).
  http.delete(apiUrl("/accounts/:id"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const id = accountId(params);
    mockDb.accounts = mockDb.accounts.filter((account) => account.id !== id);
    delete mockDb.secrets[id];
    accountsChanged(id);
    return HttpResponse.json({ success: true });
  }),

  // An empty or invalid body exports every account.
  http.post(apiUrl("/export"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    await mockDelay();
    const ids = Array.isArray(body?.ids) ? new Set(body.ids) : null;
    const accounts =
      ids && ids.size > 0
        ? mockDb.accounts.filter((account) => ids.has(account.id))
        : mockDb.accounts;
    return HttpResponse.json(makeExport(accounts));
  }),
];
