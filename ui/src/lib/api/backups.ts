import { queryOptions } from "@tanstack/react-query";
import { apiBlob, apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type {
  BackupCreateRequest,
  BackupCreateResponse,
  BackupEntry,
  BackupListResponse,
  BackupSchedule,
  BackupScheduleResponse,
  BackupScheduleUpdate,
  SuccessResponse,
} from "./types";

const backupPath = (id: string, suffix = "") => `/backups/${encodeURIComponent(id)}${suffix}`;

/** Always ?autoInclude=true; a null list becomes []. */
async function listBackups(): Promise<BackupEntry[]> {
  const res = await apiRequest<BackupListResponse>("/backups", { query: { autoInclude: "true" } });
  return res.backups ?? [];
}

export function backupsQuery() {
  return queryOptions({ queryKey: queryKeys.backups.list(), queryFn: listBackups });
}

/** A never-configured schedule is `{}`; every field is omitted when unset. */
async function getBackupSchedule(): Promise<BackupSchedule> {
  const res = await apiRequest<BackupScheduleResponse>("/backups/schedule");
  return res.schedule ?? {};
}

export function backupScheduleQuery() {
  return queryOptions({ queryKey: queryKeys.backups.schedule(), queryFn: getBackupSchedule });
}

/**
 * Answers with the saved schedule, `nextRun` included (`{}` from an older server that sends
 * none), and `pruneError` when the schedule was saved but the follow-up prune failed.
 */
export async function updateBackupSchedule(
  body: BackupScheduleUpdate,
): Promise<{ schedule: BackupSchedule; pruneError?: string }> {
  const res = await apiRequest<Partial<BackupScheduleResponse>>("/backups/schedule", {
    method: "POST",
    body,
  });
  return {
    schedule: res.schedule ?? {},
    ...(res.pruneError ? { pruneError: res.pruneError } : {}),
  };
}

/** Always sends a JSON body: the server answers an empty body with 400 Invalid JSON. */
export function createBackup(body: BackupCreateRequest): Promise<BackupCreateResponse> {
  return apiRequest("/backups", { method: "POST", body: body ?? {} });
}

/** Default file name kiro-backup-<id>.json */
export async function downloadBackup(id: string): Promise<{ blob: Blob; filename: string }> {
  const { blob, filename } = await apiBlob(backupPath(id, "/download"));
  return { blob, filename: filename ?? `kiro-backup-${id}.json` };
}

/**
 * Revokes every admin session server-side on success. 404 `backup_not_found` for an unknown id,
 * 400 with a `backup_*` code for a stored file the restore cannot read.
 */
export function restoreBackup(id: string): Promise<SuccessResponse> {
  return apiRequest(backupPath(id, "/restore"), { method: "POST" });
}

/**
 * multipart field 'file'. Revokes every admin session server-side on success. A file that is not
 * JSON, not a kiro-proxy backup, of another version or missing required fields answers 400 with
 * code backup_invalid_json, backup_unsupported_format, backup_unsupported_version or
 * backup_schema_mismatch; the message is unchanged.
 */
export function restoreBackupUpload(file: File): Promise<SuccessResponse> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiRequest("/backups/restore", { method: "POST", body: form });
}

/** 404 `backup_not_found` for an unknown id. */
export function deleteBackup(id: string): Promise<SuccessResponse> {
  return apiRequest(backupPath(id), { method: "DELETE" });
}
