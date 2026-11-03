import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import type {
  BackupCreateRequest,
  BackupCreateResponse,
  BackupEntry,
  BackupSchedule,
  BackupScheduleUpdate,
  SuccessResponse,
} from "./types";

const notImplemented = () => Promise.reject(new Error("not implemented"));

/** Always ?autoInclude=true; a null list becomes []. */
export function listBackups(): Promise<BackupEntry[]> {
  return notImplemented();
}

export function backupsQuery() {
  return queryOptions({ queryKey: queryKeys.backups.list(), queryFn: listBackups });
}

export function getBackupSchedule(): Promise<BackupSchedule> {
  return notImplemented();
}

export function backupScheduleQuery() {
  return queryOptions({ queryKey: queryKeys.backups.schedule(), queryFn: getBackupSchedule });
}

export function updateBackupSchedule(_body: BackupScheduleUpdate): Promise<SuccessResponse> {
  return notImplemented();
}

/** Always sends a JSON body. */
export function createBackup(_body: BackupCreateRequest): Promise<BackupCreateResponse> {
  return notImplemented();
}

/** Default file name kiro-backup-<id>.json */
export function downloadBackup(_id: string): Promise<{ blob: Blob; filename: string }> {
  return notImplemented();
}

export function restoreBackup(_id: string): Promise<SuccessResponse> {
  return notImplemented();
}

/** multipart field 'file' */
export function restoreBackupUpload(_file: File): Promise<SuccessResponse> {
  return notImplemented();
}

export function deleteBackup(_id: string): Promise<SuccessResponse> {
  return notImplemented();
}
