import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import { getVersion } from "./system";

/**
 * Where the self-update stands (proxy/update_api.go): nothing under way, the new release on its
 * way down, checked and in place of the running file (ready for a restart), the restart under
 * way, or failed.
 */
export type UpdateState = "idle" | "downloading" | "ready" | "restarting" | "error";

/** Why this server cannot update itself: it runs in a container, on a platform with no release
 * archive, or its executable sits in a folder it cannot write to. */
export type UpdateUnsupportedReason = "container" | "platform" | "not_writable";

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
  /** Why it failed, in plain English. */
  error?: string;
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
  };
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
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

/** How long the restart may take before the page says the server did not come back. */
export const RESTART_TIMEOUT_MS = 120_000;
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
