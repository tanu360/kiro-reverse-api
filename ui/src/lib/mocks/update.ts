import { type HttpHandler, HttpResponse, http } from "msw";
import { compareVersions } from "@/lib/api/system";
import type { UpdateStatus } from "@/lib/api/update";
import { mockDb } from "./db";
import { publishMockEvent } from "./events";
import { apiUrl, jsonError, mockDelay, requireAuth } from "./http";

/**
 * What the mock server runs as, for the update dialog: a Linux binary that can update itself
 * (the default in the browser), one in a Docker container, a Windows binary, a binary in a folder
 * it cannot write to, or a binary whose download fails its checksum. Unit tests seed `docker`.
 */
export type MockServerKind = "binary" | "docker" | "windows" | "readonly" | "fail";
export const MOCK_SERVER_KINDS: readonly MockServerKind[] = [
  "binary",
  "docker",
  "windows",
  "readonly",
  "fail",
];

/** The self-update as the mock walks it: the download takes DOWNLOAD_MS, the restart RESTART_MS. */
export interface MockUpdate {
  version: string;
  /** ms epoch the download started; 0 while idle. */
  startedAt: number;
  /** ms epoch the restart was asked for; 0 until then. */
  restartAt: number;
}

export function freshMockUpdate(): MockUpdate {
  return { version: "", startedAt: 0, restartAt: 0 };
}

const DOWNLOAD_MS = 6000;
const RESTART_MS = 4000;
const ARCHIVE_BYTES = 9_437_184;
/** The `fail` server's download stops here with a checksum error. */
const FAIL_AT = 0.62;
/** Where the browser mock remembers the version it "updated" to, so a reload runs on it. */
const UPDATED_VERSION_KEY = "kiro_mock_updated_version";

/** GET /version's answer for the mock server's kind. */
export function mockServerInfo(): { os: string; arch: string; docker: boolean } {
  switch (mockDb.server) {
    case "docker":
      return { os: "linux", arch: "amd64", docker: true };
    case "windows":
      return { os: "windows", arch: "amd64", docker: false };
    default:
      return { os: "linux", arch: "amd64", docker: false };
  }
}

function unsupported(): Pick<UpdateStatus, "supported" | "reason" | "path"> {
  if (mockDb.server === "docker") return { supported: false, reason: "container" };
  if (mockDb.server === "readonly") {
    return { supported: false, reason: "not_writable", path: "/usr/local/bin/kiro-proxy" };
  }
  return { supported: true };
}

/** GET /update, worked out from the clock like the tunnel mock. */
function mockUpdateStatus(now = Date.now()): UpdateStatus {
  const base = { state: "idle" as const, ...unsupported() };
  const update = mockDb.update;
  if (!update.startedAt) return base;
  if (update.restartAt) return { ...base, state: "restarting", version: update.version };
  const fraction = Math.min(1, (now - update.startedAt) / DOWNLOAD_MS);
  if (mockDb.server === "fail" && fraction >= FAIL_AT) {
    return {
      ...base,
      state: "error",
      version: update.version,
      error: "The download does not match the release checksum.",
      errorCode: "checksum_mismatch",
    };
  }
  if (fraction < 1) {
    const downloaded = Math.round(ARCHIVE_BYTES * fraction);
    return {
      ...base,
      state: "downloading",
      version: update.version,
      progress: Math.floor(fraction * 100),
      downloaded,
      total: ARCHIVE_BYTES,
    };
  }
  return { ...base, state: "ready", version: update.version };
}

/** True while the mock server is "down" between the restart and the new version answering. */
export function mockRestarting(now = Date.now()): boolean {
  const { restartAt } = mockDb.update;
  return restartAt > 0 && now - restartAt < RESTART_MS;
}

function finishRestart(version: string): void {
  mockDb.version = version;
  mockDb.update = freshMockUpdate();
  try {
    sessionStorage.setItem(UPDATED_VERSION_KEY, version);
  } catch {
    // Not remembered: the next reload runs the old version again.
  }
}

/** The browser mock starts on the version it updated to earlier in this tab, if newer. */
export function applyUpdatedVersion(): void {
  let version: string | null = null;
  try {
    version = sessionStorage.getItem(UPDATED_VERSION_KEY);
  } catch {
    return;
  }
  if (version && compareVersions(version, mockDb.version) > 0) mockDb.version = version;
}

export const updateHandlers: HttpHandler[] = [
  http.get(apiUrl("/update"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(mockUpdateStatus());
  }),

  http.post(apiUrl("/update"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = (await request.json().catch(() => null)) as { version?: unknown } | null;
    const version = typeof body?.version === "string" ? body.version.replace(/^v/i, "") : "";
    if (!/^\d+\.\d+\.\d+$/.test(version) || compareVersions(version, mockDb.version) <= 0) {
      return jsonError(400, `${version || "That"} is not a newer version.`, {
        code: "update_version",
      });
    }
    const status = mockUpdateStatus();
    if (!status.supported) {
      return jsonError(409, "This server cannot update itself.", { code: "update_unsupported" });
    }
    if (status.state === "downloading") {
      return jsonError(409, "An update is already downloading.", { code: "update_busy" });
    }
    if (status.state === "ready" && status.version === version) return HttpResponse.json(status);
    mockDb.update = { version, startedAt: Date.now(), restartAt: 0 };
    publishMockEvent("update_changed");
    // The real server publishes as the download moves; the page also polls while it moves.
    setTimeout(() => publishMockEvent("update_changed"), DOWNLOAD_MS + 50);
    return HttpResponse.json(mockUpdateStatus(), { status: 202 });
  }),

  http.post(apiUrl("/update/restart"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const status = mockUpdateStatus();
    if (status.state !== "ready" || !status.version) {
      return jsonError(409, "No update is ready to install.", { code: "update_not_ready" });
    }
    const version = status.version;
    mockDb.update = { ...mockDb.update, restartAt: Date.now() };
    setTimeout(() => finishRestart(version), RESTART_MS);
    return HttpResponse.json(mockUpdateStatus(), { status: 202 });
  }),
];
