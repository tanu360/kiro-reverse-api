import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";

/** The rule that joined two accounts of a group, in the order the server tries them. */
export type DuplicateReason = "refresh_token" | "api_key" | "user_id" | "email";

/** One account of a duplicate group. The server never sends a secret here. */
export interface DuplicateAccount {
  id: string;
  email: string;
  nickname: string;
  authMethod: string;
  provider: string;
  region: string;
  enabled: boolean;
  /** Enabled, not silenced or banned, and holding a token or key. */
  healthy: boolean;
  banStatus: string;
  silent: boolean;
  /** Unix seconds of the last usage refresh; 0 when never. */
  lastRefresh: number;
  expiresAt: number;
  lastUsed: number;
  requestCount: number;
  errorCount: number;
}

/** Accounts that are one Kiro user, in the server's list order. */
export interface DuplicateGroup {
  reasons: DuplicateReason[];
  /** The healthy account refreshed last, which a merge keeps by default. */
  suggestedKeepId: string;
  accounts: DuplicateAccount[];
}

export interface DuplicatesResponse {
  /** Accounts a merge of every group would remove: each group's size minus one, summed. */
  duplicateCount: number;
  groups: DuplicateGroup[];
}

export interface MergeDuplicatesRequest {
  keepId: string;
  /** The group's accounts; keepId may be among them. */
  ids: string[];
}

export interface MergeDuplicatesResponse {
  success: true;
  keptId: string;
  removed: string[];
  /** Request log rows moved to the kept account. */
  requestsMoved: number;
}

function listDuplicates(): Promise<DuplicatesResponse> {
  return apiRequest<DuplicatesResponse>("/accounts/duplicates").then((res) => ({
    duplicateCount: res.duplicateCount ?? 0,
    groups: res.groups ?? [],
  }));
}

export function duplicatesQuery() {
  return queryOptions({
    queryKey: queryKeys.accounts.duplicates(),
    queryFn: listDuplicates,
  });
}

/**
 * Keeps `keepId` and removes the rest of `ids`: a backup is taken first, the counters are summed
 * into the kept account and the request history moves to it. A group that changed since it was
 * listed answers 409 `duplicates_changed`.
 */
export function mergeDuplicates(req: MergeDuplicatesRequest): Promise<MergeDuplicatesResponse> {
  return apiRequest("/accounts/duplicates/merge", { method: "POST", body: req });
}
