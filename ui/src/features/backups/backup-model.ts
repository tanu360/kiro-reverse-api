import { serverDataText } from "@/lib/api/server-errors";
import type { BackupCadence, BackupEntry, BackupSchedule } from "@/lib/api/types";
import { EMPTY, formatBytes, formatDateTime, formatNumber } from "@/lib/format";
import type { Lang, TFunction, TParams } from "@/lib/i18n";

/** The server caps every request body at 32 MiB and answers a larger one with a plain 413. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export const KEEP_MIN = 1;
export const KEEP_MAX = 200;
/** The keep the server applies while none was ever set (GET answers it; an older server omits it). */
const KEEP_DEFAULT = 50;

export const CADENCES: readonly BackupCadence[] = ["hourly", "daily", "weekly"];

const UPLOAD_PREFIX = "upload ";
const RESTORE_PREFIX = "auto before restore ";
const SCHEDULED_NOTE = /^auto-(hourly|daily|weekly)$/;
/** The note manualNote writes: only the creation time again, in another format. */
const MANUAL_NOTE = /^manual backup \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** The note of the backup a duplicate merge saves first (proxy/account_dedup.go). */
const MERGE_NOTE = "before merging duplicate accounts";
/** That backup's kind. Older versions saved it as "auto" with the note above. */
const MERGE_KIND = "pre-merge";

type BackupTone = "primary" | "neutral" | "warning";

export interface ScheduleForm {
  enabled: boolean;
  cadence: BackupCadence;
  keep: number;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `manual backup YYYY-MM-DD HH:MM:SS` in local time, the note the old UI wrote. */
export function manualNote(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `manual backup ${day} ${time}`;
}

/**
 * The keep to send. The stored keep goes back unchanged, so a legacy value above 200 stays valid
 * (the server accepts one only when it equals the stored keep); any other value is rounded into
 * 1..200, and anything that is not a number keeps the stored value.
 */
export function clampKeep(value: number, stored: number = KEEP_DEFAULT): number {
  if (!Number.isFinite(value)) return stored;
  const whole = Math.round(value);
  if (whole === stored) return stored;
  return Math.min(KEEP_MAX, Math.max(KEEP_MIN, whole));
}

/** The Keep field's max: 200, or a larger legacy keep, so the field can show it as stored. */
export function keepMax(stored: number): number {
  return Math.max(KEEP_MAX, stored);
}

function isCadence(value: unknown): value is BackupCadence {
  return CADENCES.includes(value as BackupCadence);
}

/**
 * Every schedule field is omitempty on the wire, so `{}` means off and daily. Keep is shown as
 * the server applies it, never clamped: 50 when unset, a legacy value above 200 as stored.
 */
export function scheduleForm(schedule: BackupSchedule): ScheduleForm {
  return {
    enabled: Boolean(schedule.enabled),
    cadence: isCadence(schedule.cadence) ? schedule.cadence : "daily",
    keep: schedule.keep && schedule.keep > 0 ? schedule.keep : KEEP_DEFAULT,
  };
}

/** True when saving would change the schedule. An emptied keep field counts as a change. */
export function scheduleDirty(
  initial: ScheduleForm,
  current: { enabled: boolean; cadence: BackupCadence; keep: number | null },
): boolean {
  if (current.keep === null) return true;
  return (
    current.enabled !== initial.enabled ||
    current.cadence !== initial.cadence ||
    clampKeep(current.keep, initial.keep) !== initial.keep
  );
}

/** A scheduled backup's note: how often it runs, since its Kind already says Scheduled. */
const CADENCE_NOTE: Record<BackupCadence, string> = {
  hourly: "noteEveryHour",
  daily: "noteEveryDay",
  weekly: "noteEveryWeek",
};

/** When a backup was made, read from its id (config/backup.go: UTC `20060102-150405-…`). */
function backupIdTime(id: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

const KIND_KEYS: Record<string, string> = {
  manual: "kindManual",
  scheduled: "kindScheduled",
  auto: "kindAuto",
  "pre-restore": "kindPreRestore",
  [MERGE_KIND]: "kindPreMerge",
};

/**
 * The kind a row shows. The server files the backup a duplicate merge saves first as
 * "pre-merge"; older versions filed it as "auto" with a fixed note, so such a row also shows
 * "Before merge" instead of "Before save". Every other row keeps the server's kind.
 */
export function backupKind(entry: Pick<BackupEntry, "kind" | "note">): string {
  if (entry.kind === "auto" && (entry.note ?? "").trim() === MERGE_NOTE) return MERGE_KIND;
  return entry.kind;
}

/** Known kinds are translated; any other kind is shown as the server sent it. */
export function kindLabel(kind: string, t: TFunction): string {
  const key = KIND_KEYS[kind];
  if (key) return t(key);
  return kind || EMPTY;
}

/** A backup someone made stands out, a rollback point warns, the automatic ones stay quiet. */
export function kindTone(kind: string): BackupTone {
  if (kind === "manual") return "primary";
  if (kind === "pre-restore") return "warning";
  return "neutral";
}

/** The Saved backups card meta: "6 backups · 1.2 MB". */
export function listMeta(rows: readonly BackupEntry[], t: TFunction, lang?: Lang): string {
  const total = rows.reduce((sum, row) => sum + (row.size || 0), 0);
  return t("list.meta", {
    count: rows.length,
    n: formatNumber(rows.length, lang),
    size: formatBytes(total, lang),
  });
}

/**
 * The note column. Rollback-point, merge and scheduled notes are generated by the server and are
 * described in words that do not repeat the Kind beside them ("Every hour", not "Scheduled
 * (Hourly)"); a restored backup is named by its time, not its long id. The note this page writes
 * for a manual backup only repeats the Time column (in English and 24-hour time), so it reads as
 * no note. Any other note is shown with emails masked by `mask`.
 */
export function noteText(
  entry: BackupEntry,
  t: TFunction,
  mask: (text?: string) => string = (text) => text ?? "",
  lang?: Lang,
): string {
  const note = (entry.note ?? "").trim();
  if (!note) return EMPTY;
  if (entry.kind === "pre-restore") {
    if (note.startsWith(UPLOAD_PREFIX)) {
      return t("noteBeforeUpload", { name: mask(note.slice(UPLOAD_PREFIX.length)) });
    }
    if (note.startsWith(RESTORE_PREFIX)) {
      const id = note.slice(RESTORE_PREFIX.length);
      const at = backupIdTime(id);
      return at === null
        ? t("noteBeforeRestore", { id: mask(id) })
        : t("noteBeforeRestoreAt", { time: formatDateTime(at, lang) });
    }
  }
  if (backupKind(entry) === MERGE_KIND && note === MERGE_NOTE) return t("noteBeforeMerge");
  if (entry.kind === "manual" && MANUAL_NOTE.test(note)) return EMPTY;
  if (entry.kind === "scheduled") {
    const match = SCHEDULED_NOTE.exec(note);
    if (match) return t(CADENCE_NOTE[match[1] as BackupCadence]);
  }
  // Another note the server writes itself (config/account_rows.go) is in words too.
  const serverNote = serverDataText(note, t);
  if (serverNote !== note) return serverNote;
  return mask(note) || EMPTY;
}

/**
 * "Accounts in backup": a rollback point counts what the restore brought in. A row without a
 * count shows "—", not 0. (The server omits a zero count, so an empty backup reads "—" too.)
 */
export function accountsCell(
  entry: BackupEntry,
  t: TFunction,
  lang?: Lang,
): { text: string; hint?: string } {
  if (entry.kind === "pre-restore" && typeof entry.restoredAccountCnt === "number") {
    const saved = entry.accountCnt ?? 0;
    return {
      text: t("restoredAccountCount", {
        count: entry.restoredAccountCnt,
        n: formatNumber(entry.restoredAccountCnt, lang),
      }),
      hint: t("preRestoreSavedHint", { count: saved, n: formatNumber(saved, lang) }),
    };
  }
  if (typeof entry.accountCnt !== "number") return { text: EMPTY };
  return { text: formatNumber(entry.accountCnt, lang) };
}

// Server messages (config/backup.go parseBackupData) for a file that is not a usable backup.
const NOT_A_BACKUP = [
  /^backup content is not valid JSON$/i,
  /^backup JSON parse failed\b/i,
  /^unsupported backup format\b/i,
  /^backup envelope parse failed\b/i,
  /^unsupported backup version\b/i,
  /^backup schema mismatch\b/i,
  /^credential \d+ missing id$/i,
];

/** True when the server rejected an uploaded file because it is not a Kiro Proxy backup. */
export function isNotABackupMessage(message: string): boolean {
  const text = message.trim();
  return NOT_A_BACKUP.some((pattern) => pattern.test(text));
}

const MARKER = "\u0000";

/**
 * The text before and after one placeholder of a message ("Last run {time}"), so a component
 * such as a live RelativeTime can sit where the value goes. The parts keep their own spacing.
 */
export function messageParts(
  t: TFunction,
  key: string,
  name: string,
  params: TParams = {},
): [string, string] {
  const [before = "", after = ""] = t(key, { ...params, [name]: MARKER }).split(MARKER);
  return [before, after];
}
