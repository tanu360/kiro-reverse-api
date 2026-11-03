import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { ApiError } from "./errors";
import { queryKeys } from "./query-keys";
import type {
  MachineIdResponse,
  RemoteVersionJson,
  StatusResponse,
  VersionResponse,
} from "./types";

export function getStatus(): Promise<StatusResponse> {
  return apiRequest("/status");
}

/** The old UI polled /status every 10 s while signed in and visible. */
export function statusQuery() {
  return queryOptions({
    queryKey: queryKeys.status,
    queryFn: getStatus,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function getVersion(): Promise<VersionResponse> {
  return apiRequest("/version");
}

export function versionQuery() {
  return queryOptions({
    queryKey: queryKeys.version,
    queryFn: getVersion,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function generateMachineId(): Promise<MachineIdResponse> {
  return apiRequest("/generate-machine-id");
}

export const REMOTE_VERSION_URL =
  "https://raw.githubusercontent.com/tanu360/kiro-reverse-api/main/version.json";

/** Plain fetch with ?t=Date.now(), cache 'no-store', no admin headers. */
export async function fetchRemoteVersion(): Promise<RemoteVersionJson> {
  let response: Response;
  try {
    response = await fetch(`${REMOTE_VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
  } catch {
    throw new ApiError({ status: 0, serverMessage: "network" });
  }
  if (!response.ok) {
    throw new ApiError({ status: response.status, serverMessage: response.statusText });
  }
  const data: unknown = await response.json().catch(() => null);
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { version?: unknown }).version !== "string"
  ) {
    throw new ApiError({
      status: response.status,
      serverMessage: "invalid version.json",
      body: data,
    });
  }
  const { version, changelog, download } = data as Record<string, unknown>;
  return {
    version: version as string,
    ...(typeof changelog === "string" ? { changelog } : {}),
    ...(typeof download === "string" ? { download } : {}),
  };
}

function versionParts(value: string): number[] {
  return String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Strips a leading v/V and compares numeric dotted parts: -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
