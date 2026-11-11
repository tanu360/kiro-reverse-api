import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  BackupCadence,
  BackupEntry,
  BackupFile,
  BackupSchedule,
  BackupScheduleUpdate,
} from "@/lib/api/types";
import { claimMockPassword, mockDb, mockNowUnix } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import { makeBackupEntry } from "@/lib/mocks/fixtures";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";

const BACKUP_FORMAT = "kiro-proxy-backup";
const BODY_LIMIT = 32 * 1024 * 1024;
const KEEP_MIN = 1;
const KEEP_MAX = 200;
/** What PruneScheduled keeps when keep was never set. */
const KEEP_DEFAULT = 50;
/** The Go scheduler checks every 5 minutes, on wall-clock multiples. */
const TICK_SECONDS = 300;
const INTERVAL_SECONDS: Record<BackupCadence, number> = {
  hourly: 3600,
  daily: 86400,
  weekly: 604800,
};

function isCadence(value: unknown): value is BackupCadence {
  return typeof value === "string" && Object.hasOwn(INTERVAL_SECONDS, value);
}

/** max(lastRun + interval, now) rounded up to the next tick; undefined while off. */
function nextRun(schedule: BackupSchedule): number | undefined {
  if (!schedule.enabled || !isCadence(schedule.cadence)) return undefined;
  const now = mockNowUnix();
  // Like Go's trustedLastRun: a lastRun ahead of the clock counts as never run.
  const due =
    schedule.lastRun && schedule.lastRun <= now
      ? Math.max(schedule.lastRun + INTERVAL_SECONDS[schedule.cadence], now)
      : now;
  return Math.ceil(due / TICK_SECONDS) * TICK_SECONDS;
}

/** Keeps the newest `keep` scheduled backups, like config.PruneScheduled. */
/** Go's PruneScheduled: drops the scheduled backups beyond `keep`; returns how many. */
function pruneScheduled(keep: number): number {
  const scheduled = sortBackups(mockDb.backups.filter((row) => row.kind === "scheduled"));
  const drop = new Set(scheduled.slice(keep).map((row) => row.id));
  mockDb.backups = mockDb.backups.filter((row) => !drop.has(row.id));
  return drop.size;
}

function notFound(id: string): Response {
  return jsonError(404, `backup not found: ${id}`, { code: "backup_not_found" });
}

/** Server order: createdAt DESC, id DESC. */
function sortBackups(rows: BackupEntry[]): BackupEntry[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

function findBackup(id: string): BackupEntry | undefined {
  return mockDb.backups.find((row) => row.id === id);
}

function addBackup(fields: Partial<BackupEntry>): BackupEntry {
  const backup = makeBackupEntry({
    createdAt: mockNowUnix(),
    accountCnt: mockDb.accounts.length || undefined,
    ...fields,
  });
  mockDb.backups = sortBackups([backup, ...mockDb.backups]);
  return backup;
}

/** The stored backup file: the whole config plus credentials, as the server writes it. */
function backupFile(entry: BackupEntry): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: entry.createdAt,
    config: {
      password: mockDb.adminPassword,
      port: 8080,
      host: "0.0.0.0",
      requireApiKey: mockDb.settings.requireApiKey,
      accounts: mockDb.accounts,
    },
    credentialsLoaded: true,
    credentials: Object.values(mockDb.secrets).map((secret) => ({ ...secret })),
  };
}

/** Go's json omitempty: false, 0 and "" fields are left out. */
function wireSchedule(schedule: BackupSchedule): BackupSchedule {
  const out: BackupSchedule = {};
  if (schedule.enabled) out.enabled = true;
  if (schedule.cadence) out.cadence = schedule.cadence;
  // Like Go's scheduleView: keep is the one applied, so 50 when never set.
  out.keep = schedule.keep || KEEP_DEFAULT;
  if (schedule.lastRun) out.lastRun = schedule.lastRun;
  const next = nextRun(schedule);
  if (next) out.nextRun = next;
  return out;
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await request.text();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates backup bytes like config.parseBackupData and returns the number of accounts the
 * restore brings in, or the server's 400 message and code.
 */
function parseBackup(text: string): { accounts: number } | { error: string; code: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "backup content is not valid JSON", code: "backup_invalid_json" };
  }
  if (!isRecord(data) || data.format !== BACKUP_FORMAT) {
    return {
      error: `unsupported backup format: expected ${BACKUP_FORMAT}`,
      code: "backup_unsupported_format",
    };
  }
  if (data.version !== 1) {
    return {
      error: `unsupported backup version: ${String(data.version)}`,
      code: "backup_unsupported_version",
    };
  }
  const config = isRecord(data.config) ? data.config : null;
  if (!config?.password) {
    return { error: "backup schema mismatch: missing password", code: "backup_schema_mismatch" };
  }
  const credentials = Array.isArray(data.credentials) ? data.credentials : null;
  const accounts = Array.isArray(config.accounts) ? config.accounts : [];
  return { accounts: (credentials ?? accounts).length };
}

/** Creates the rollback point, then "swaps" the config (the mock keeps its own data). */
function restoreFrom(note: string, restoredAccountCnt: number): void {
  addBackup({ kind: "pre-restore", note, restoredAccountCnt });
  claimMockPassword();
}

export const handlers: HttpHandler[] = [
  // /backups/schedule and /backups/restore are matched before /backups/:id, like Go.
  http.get(apiUrl("/backups/schedule"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ schedule: wireSchedule(mockDb.schedule) });
  }),

  http.post(apiUrl("/backups/schedule"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readJson(request);
    if (!body.ok || !isRecord(body.value)) return jsonError(400, "Invalid JSON");
    const update = body.value as Partial<BackupScheduleUpdate>;
    if (!isCadence(update.cadence)) {
      return jsonError(400, "cadence must be hourly, daily or weekly", { code: "invalid_cadence" });
    }
    const keep = update.keep;
    // Like Go: a stored legacy keep above the max stays valid while it is sent back unchanged.
    const legacyKeep = typeof keep === "number" && keep > KEEP_MAX && keep === mockDb.schedule.keep;
    if (
      typeof keep !== "number" ||
      !Number.isInteger(keep) ||
      ((keep < KEEP_MIN || keep > KEEP_MAX) && !legacyKeep)
    ) {
      return jsonError(400, `keep must be between ${KEEP_MIN} and ${KEEP_MAX}`, {
        code: "invalid_keep",
      });
    }
    // lastRun is preserved.
    mockDb.schedule = {
      lastRun: mockDb.schedule.lastRun,
      enabled: Boolean(update.enabled),
      cadence: update.cadence,
      keep,
    };
    // Like Go: a schedule that is off never prunes; one that is on prunes on every save.
    if (mockDb.schedule.enabled && pruneScheduled(keep) > 0) {
      publishMockEvent("backup_deleted", "*");
    }
    return HttpResponse.json({ schedule: wireSchedule(mockDb.schedule) });
  }),

  http.post(apiUrl("/backups/restore"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const contentType = request.headers.get("Content-Type") ?? "";
    let text: string;
    let note: string;
    if (contentType.startsWith("multipart/form-data")) {
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return jsonError(400, "Failed to parse multipart");
      }
      const file = form.get("file");
      // Duck-typed: under vitest the File class of the request differs from the global one.
      if (!file || typeof file === "string") return jsonError(400, "No file uploaded");
      if (file.size > BODY_LIMIT) {
        return new HttpResponse("request body exceeds 32 MiB limit", {
          status: 413,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      text = await file.text();
      note = `upload ${file.name}`;
    } else {
      text = await request.text();
      note = "upload uploaded";
    }
    const parsed = parseBackup(text);
    if ("error" in parsed) return jsonError(400, parsed.error, { code: parsed.code });
    restoreFrom(note, parsed.accounts);
    publishMockEvent("backup_restored", "upload");
    return HttpResponse.json({ success: true });
  }),

  http.get(apiUrl("/backups"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const autoInclude = new URL(request.url).searchParams.get("autoInclude") === "true";
    const rows = sortBackups(mockDb.backups).filter((row) => autoInclude || row.kind !== "auto");
    return HttpResponse.json({ backups: rows.length > 0 ? rows : null });
  }),

  http.post(apiUrl("/backups"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readJson(request);
    if (!body.ok || !isRecord(body.value)) return jsonError(400, "Invalid JSON");
    const { kind, note } = body.value;
    const backup = addBackup({
      kind: typeof kind === "string" && kind ? kind : "manual",
      note: typeof note === "string" && note ? note : undefined,
    });
    publishMockEvent("backup_created", backup.id);
    return HttpResponse.json({ backup });
  }),

  http.get(apiUrl("/backups/:id/download"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const id = String(params.id);
    const backup = findBackup(id);
    if (!backup) return notFound(id);
    const bytes = JSON.stringify(backupFile(backup), null, 2);
    return new HttpResponse(bytes, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="kiro-backup-${id}.json"`,
      },
    });
  }),

  http.post(apiUrl("/backups/:id/restore"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const id = String(params.id);
    const backup = findBackup(id);
    if (!backup) return notFound(id);
    restoreFrom(`auto before restore ${id}`, backup.accountCnt ?? 0);
    publishMockEvent("backup_restored", id);
    return HttpResponse.json({ success: true });
  }),

  http.delete(apiUrl("/backups/:id"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const id = String(params.id);
    if (!findBackup(id)) return notFound(id);
    mockDb.backups = mockDb.backups.filter((row) => row.id !== id);
    publishMockEvent("backup_deleted", id);
    return HttpResponse.json({ success: true });
  }),
];
