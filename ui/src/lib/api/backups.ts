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
export async function listBackups(): Promise<BackupEntry[]> {
  const res = await apiRequest<BackupListResponse>("/backups", { query: { autoInclude: "true" } });
  return res.backups ?? [];
}

export function backupsQuery() {
  return queryOptions({ queryKey: queryKeys.backups.list(), queryFn: listBackups });
}

/** A never-configured schedule is `{}`; every field is omitted when unset. */
export async function getBackupSchedule(): Promise<BackupSchedule> {
  const res = await apiRequest<BackupScheduleResponse>("/backups/schedule");
  return res.schedule ?? {};
}

export function backupScheduleQuery() {
  return queryOptions({ queryKey: queryKeys.backups.schedule(), queryFn: getBackupSchedule });
}

export function updateBackupSchedule(body: BackupScheduleUpdate): Promise<SuccessResponse> {
  return apiRequest("/backups/schedule", { method: "POST", body });
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

/** Revokes every admin session server-side on success. */
export function restoreBackup(id: string): Promise<SuccessResponse> {
  return apiRequest(backupPath(id, "/restore"), { method: "POST" });
}

/** multipart field 'file'. Revokes every admin session server-side on success. */
export function restoreBackupUpload(file: File): Promise<SuccessResponse> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiRequest("/backups/restore", { method: "POST", body: form });
}

export function deleteBackup(id: string): Promise<SuccessResponse> {
  return apiRequest(backupPath(id), { method: "DELETE" });
}
