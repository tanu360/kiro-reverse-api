import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type {
  Account,
  AccountFull,
  AccountModelsCachedResponse,
  AccountModelsResponse,
  AccountProfilesResponse,
  BatchAccountsRequest,
  BatchAccountsResponse,
  ExportData,
  OverageResponse,
  RefreshAccountModelsResponse,
  RefreshAccountResponse,
  RefreshAllModelsResponse,
  SetAccountProfileResponse,
  SuccessResponse,
  TestAccountRequest,
  TestAccountResponse,
  UpdateAccountRequest,
} from "./types";

const accountPath = (id: string, suffix = "") => `/accounts/${encodeURIComponent(id)}${suffix}`;

function listAccounts(): Promise<Account[]> {
  return apiRequest<Account[] | null>("/accounts").then((list) => list ?? []);
}

export function accountsQuery() {
  return queryOptions({
    queryKey: queryKeys.accounts.list(),
    queryFn: listAccounts,
  });
}

export function updateAccount(id: string, patch: UpdateAccountRequest): Promise<SuccessResponse> {
  return apiRequest(accountPath(id), { method: "PUT", body: patch });
}

export function deleteAccount(id: string): Promise<SuccessResponse> {
  return apiRequest(accountPath(id), { method: "DELETE" });
}

/**
 * Every action answers with per-id `results`. refresh and refreshModels run 8 accounts at a
 * time on the server; unknown ids count as failed with status "not_found".
 */
export function batchAccounts(req: BatchAccountsRequest): Promise<BatchAccountsResponse> {
  return apiRequest("/accounts/batch", { method: "POST", body: req });
}

export function refreshAccount(id: string): Promise<RefreshAccountResponse> {
  return apiRequest(accountPath(id, "/refresh"), { method: "POST" });
}

export function testAccount(id: string, req: TestAccountRequest): Promise<TestAccountResponse> {
  return apiRequest(accountPath(id, "/test"), { method: "POST", body: req });
}

/** Live list from AWS. No query options: features call it on demand. */
export function getAccountModels(id: string): Promise<AccountModelsResponse> {
  return apiRequest<AccountModelsResponse>(accountPath(id, "/models")).then((res) => ({
    ...res,
    models: res.models ?? [],
  }));
}

export function getAccountModelsCached(id: string): Promise<AccountModelsCachedResponse> {
  return apiRequest<AccountModelsCachedResponse>(accountPath(id, "/models/cached")).then((res) => ({
    ...res,
    models: res.models ?? [],
  }));
}

export function refreshAccountModels(id: string): Promise<RefreshAccountModelsResponse> {
  return apiRequest(accountPath(id, "/models/refresh"), { method: "POST" });
}

/** `refreshed` and `failed` count accounts; `models` is the cached model count. */
export function refreshAllModels(): Promise<RefreshAllModelsResponse> {
  return apiRequest("/accounts/models/refresh", { method: "POST" });
}

export function getAccountOverage(id: string): Promise<OverageResponse> {
  return apiRequest(accountPath(id, "/overage"));
}

export function setAccountOverage(id: string, enabled: boolean): Promise<OverageResponse> {
  return apiRequest(accountPath(id, "/overage"), { method: "POST", body: { enabled } });
}

/** Discovers Kiro profiles upstream. No query options: features call it on demand. */
export function getAccountProfiles(id: string): Promise<AccountProfilesResponse> {
  return apiRequest<AccountProfilesResponse>(accountPath(id, "/profiles")).then((res) => ({
    ...res,
    profiles: res.profiles ?? [],
  }));
}

/** An empty profileArn unpins the account. */
export function setAccountProfile(
  id: string,
  profileArn: string,
): Promise<SetAccountProfileResponse> {
  return apiRequest(accountPath(id, "/profile"), { method: "POST", body: { profileArn } });
}

/** Full secrets. Never cache. */
export function getAccountFull(id: string): Promise<AccountFull> {
  return apiRequest(accountPath(id, "/full"));
}

/** POST /export { ids }. The server exports every account for an empty list; callers guard it. */
export function exportAccounts(ids: string[]): Promise<ExportData> {
  return apiRequest("/export", { method: "POST", body: { ids } });
}
