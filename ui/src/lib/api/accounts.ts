import { queryOptions } from "@tanstack/react-query";
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

const notImplemented = () => Promise.reject(new Error("not implemented"));

export function listAccounts(): Promise<Account[]> {
  return notImplemented();
}

export function accountsQuery() {
  return queryOptions({
    queryKey: queryKeys.accounts.list(),
    queryFn: listAccounts,
  });
}

export function updateAccount(_id: string, _patch: UpdateAccountRequest): Promise<SuccessResponse> {
  return notImplemented();
}

export function deleteAccount(_id: string): Promise<SuccessResponse> {
  return notImplemented();
}

export function batchAccounts(_req: BatchAccountsRequest): Promise<BatchAccountsResponse> {
  return notImplemented();
}

export function refreshAccount(_id: string): Promise<RefreshAccountResponse> {
  return notImplemented();
}

export function testAccount(_id: string, _req: TestAccountRequest): Promise<TestAccountResponse> {
  return notImplemented();
}

export function getAccountModels(_id: string): Promise<AccountModelsResponse> {
  return notImplemented();
}

export function getAccountModelsCached(_id: string): Promise<AccountModelsCachedResponse> {
  return notImplemented();
}

export function refreshAccountModels(_id: string): Promise<RefreshAccountModelsResponse> {
  return notImplemented();
}

export function refreshAllModels(): Promise<RefreshAllModelsResponse> {
  return notImplemented();
}

export function getAccountOverage(_id: string): Promise<OverageResponse> {
  return notImplemented();
}

export function setAccountOverage(_id: string, _enabled: boolean): Promise<OverageResponse> {
  return notImplemented();
}

export function getAccountProfiles(_id: string): Promise<AccountProfilesResponse> {
  return notImplemented();
}

export function setAccountProfile(
  _id: string,
  _profileArn: string,
): Promise<SetAccountProfileResponse> {
  return notImplemented();
}

/** Full secrets. Never cache. */
export function getAccountFull(_id: string): Promise<AccountFull> {
  return notImplemented();
}

/** POST /export { ids } */
export function exportAccounts(_ids: string[]): Promise<ExportData> {
  return notImplemented();
}
