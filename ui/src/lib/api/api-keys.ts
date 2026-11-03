import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import type {
  ApiKey,
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyDetailResponse,
  ApiKeyResetUsageResponse,
  ApiKeyUpdateRequest,
  ApiKeyUpdateResponse,
  SuccessResponse,
} from "./types";

const notImplemented = () => Promise.reject(new Error("not implemented"));

export function listApiKeys(): Promise<ApiKey[]> {
  return notImplemented();
}

export function apiKeysQuery() {
  return queryOptions({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: listApiKeys,
  });
}

/** Full secret. Never cache. */
export function getApiKey(_id: string): Promise<ApiKeyDetailResponse> {
  return notImplemented();
}

export function createApiKey(_req: ApiKeyCreateRequest): Promise<ApiKeyCreateResponse> {
  return notImplemented();
}

export function updateApiKey(
  _id: string,
  _req: ApiKeyUpdateRequest,
): Promise<ApiKeyUpdateResponse> {
  return notImplemented();
}

export function deleteApiKey(_id: string): Promise<SuccessResponse> {
  return notImplemented();
}

export function resetApiKeyUsage(_id: string): Promise<ApiKeyResetUsageResponse> {
  return notImplemented();
}
