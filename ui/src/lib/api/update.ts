import { queryOptions } from "@tanstack/react-query";
import type { TFunction } from "@/lib/i18n";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import { withDetail } from "./server-errors";
import { getVersion } from "./system";

/**
 * Where the self-update stands (proxy/update_api.go): nothing under way, the new release on its
 * way down, checked and in place of the running file (ready for a restart), the restart under
 * way, or failed.
 */
type UpdateState = "idle" | "downloading" | "ready" | "restarting" | "error";

/** Why this server cannot update itself: it runs in a container, on a platform with no release
 * archive, or its executable sits in a folder it cannot write to. */
type UpdateUnsupportedReason = "container" | "platform" | "not_writable";

/** GET /admin/api/update */
export interface UpdateStatus {
  state: UpdateState;
  /** The server can download and install a release by itself. */
  supported: boolean;
  reason?: UpdateUnsupportedReason;
  /** The running executable, for the not_writable notice. */
  path?: string;
  /** The version being downloaded, ready, restarting into, or that failed. */
  version?: string;
  /** 0 to 100 while downloading; absent when the size is unknown. */
  progress?: number;
  downloaded?: number;
  total?: number;
  /** Why it failed, in plain English; the UI words it from `errorCode` (updateErrorText). */
  error?: string;
  /** Why it failed (updater/download.go Fail*), for the UI to word in its language. */
  errorCode?: string;
  /** The underlying error, GitHub's status or file, or the old program's path on a rollback. */
  errorDetail?: string;
  /** After a later download failed: the release an earlier one put in place, which a restart runs. */
  installed?: string;
}

const UPDATE_STATES: readonly UpdateState[] = [
  "idle",
  "downloading",
  "ready",
  "restarting",
  "error",
];
const REASONS: readonly UpdateUnsupportedReason[] = ["container", "platform", "not_writable"];

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function byteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/** The server's answer with every field in its type; an unknown state reads as an error. */
export function normalizeUpdateStatus(
  res: Partial<Record<keyof UpdateStatus, unknown>>,
): UpdateStatus {
  const state = UPDATE_STATES.includes(res.state as UpdateState)
    ? (res.state as UpdateState)
    : "error";
  return {
    state,
    supported: res.supported === true,
    reason: REASONS.includes(res.reason as UpdateUnsupportedReason)
      ? (res.reason as UpdateUnsupportedReason)
      : undefined,
    path: optionalString(res.path),
    version: optionalString(res.version),
    progress:
      typeof res.progress === "number" && Number.isFinite(res.progress)
        ? Math.min(100, Math.max(0, Math.round(res.progress)))
        : undefined,
    downloaded: byteCount(res.downloaded),
    total: byteCount(res.total),
    error: optionalString(res.error),
    errorCode: optionalString(res.errorCode),
    errorDetail: optionalString(res.errorDetail),
    installed: optionalString(res.installed),
  };
}

/** Status.ErrorCode (updater/download.go) -> translation key. */
const UPDATE_ERROR_KEYS: Readonly<Record<string, string>> = {
  download_failed: "errors:updateError.downloadFailed",
  not_published: "errors:updateError.notPublished",
  no_checksum: "errors:updateError.noChecksum",
  checksum_mismatch: "errors:updateError.checksumMismatch",
  too_large: "errors:updateError.tooLarge",
  archive_invalid: "errors:updateError.archiveInvalid",
  write_failed: "errors:updateError.writeFailed",
  swap_failed: "errors:updateError.swapFailed",
  rollback_failed: "errors:updateError.rollbackFailed",
};

/**
 * Why the update failed, in the UI language: the code's text with the server's detail after it
 * (on a rollback the detail is the old program's path, inside the text). An unknown code, or a
 * server without codes, shows the server's English; undefined when there is no reason at all.
 */
export function updateErrorText(
  status: Pick<UpdateStatus, "error" | "errorCode" | "errorDetail" | "version">,
  t: TFunction,
): string | undefined {
  const key = status.errorCode ? UPDATE_ERROR_KEYS[status.errorCode] : undefined;
  if (!key) return status.error;
  if (status.errorCode === "rollback_failed") return t(key, { path: status.errorDetail ?? "" });
  return withDetail(t(key, { version: status.version ?? "" }), status.errorDetail, t);
}

async function getUpdateStatus(): Promise<UpdateStatus> {
  return normalizeUpdateStatus(await apiRequest("/update"));
}

/** States that move on their own: polled every second while shown, in case events are off. */
export function updateMoving(status: UpdateStatus | undefined): boolean {
  return status?.state === "downloading" || status?.state === "restarting";
}

export function updateStatusQuery(enabled: boolean) {
  return queryOptions({
    queryKey: queryKeys.update,
    queryFn: getUpdateStatus,
    enabled,
    // An older server without the endpoint answers 404: it cannot update itself, no retry.
    retry: false,
    refetchInterval: (query) => (updateMoving(query.state.data) ? 1000 : false),
  });
}

/** POST /update: starts downloading `version` (a newer release) in the background. */
export async function startUpdate(version: string): Promise<UpdateStatus> {
  return normalizeUpdateStatus(await apiRequest("/update", { method: "POST", body: { version } }));
}

/** POST /update/restart: the server answers, then restarts on the release it has in place. */
export async function restartForUpdate(): Promise<UpdateStatus> {
  return normalizeUpdateStatus(await apiRequest("/update/restart", { method: "POST" }));
}

/**
 * Restarts the server on the release in place and resolves once it answers on it. That release
 * is the one the server says it restarts into, not always `target`: after a later download failed,
 * the earlier one still in place runs. Rejects like waitForVersion.
 */
export async function restartAndWait(
  target: string,
  options?: Parameters<typeof waitForVersion>[1],
): Promise<void> {
  const status = await restartForUpdate();
  await waitForVersion(status.version ?? target, options);
}

/** How long the restart may take before the page says the server did not come back. */
const RESTART_TIMEOUT_MS = 120_000;
const RESTART_POLL_MS = 1000;

/**
 * Resolves once GET /version answers with `version` (the server is back on the new release);
 * rejects after `timeoutMs`. Failed requests while the server is down are expected and retried.
 */
export async function waitForVersion(
  version: string,
  { timeoutMs = RESTART_TIMEOUT_MS, pollMs = RESTART_POLL_MS } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const want = version.replace(/^v/i, "");
  while (Date.now() < deadline) {
    try {
      const running = await getVersion();
      if (running.version.replace(/^v/i, "") === want) return;
    } catch {
      // Down while it restarts.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("timeout");
}
