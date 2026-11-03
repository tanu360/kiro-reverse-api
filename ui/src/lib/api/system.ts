import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import type {
  MachineIdResponse,
  RemoteVersionJson,
  StatusResponse,
  VersionResponse,
} from "./types";

const notImplemented = () => Promise.reject(new Error("not implemented"));

export function getStatus(): Promise<StatusResponse> {
  return notImplemented();
}

export function statusQuery() {
  return queryOptions({
    queryKey: queryKeys.status,
    queryFn: getStatus,
    refetchInterval: 10_000,
  });
}

export function getVersion(): Promise<VersionResponse> {
  return notImplemented();
}

export function versionQuery() {
  return queryOptions({
    queryKey: queryKeys.version,
    queryFn: getVersion,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function generateMachineId(): Promise<MachineIdResponse> {
  return notImplemented();
}

export const REMOTE_VERSION_URL =
  "https://raw.githubusercontent.com/tanu360/kiro-reverse-api/main/version.json";

/** Plain fetch with ?t=Date.now(), cache 'no-store', no admin headers. */
export function fetchRemoteVersion(): Promise<RemoteVersionJson> {
  return notImplemented();
}

/** Strips a leading v/V and compares numeric dotted parts: -1, 0 or 1. Skeleton: equal. */
export function compareVersions(_a: string, _b: string): number {
  return 0;
}
