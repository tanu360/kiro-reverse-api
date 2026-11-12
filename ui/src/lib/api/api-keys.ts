import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type {
  ApiKey,
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyDetailResponse,
  ApiKeyListResponse,
  ApiKeyRegenerateResponse,
  ApiKeyResetUsageResponse,
  ApiKeyUpdateRequest,
  ApiKeyUpdateResponse,
  SuccessResponse,
} from "./types";

const keyPath = (id: string, suffix = "") => `/api-keys/${encodeURIComponent(id)}${suffix}`;

/** The list carries only `keyMasked`, never the secret. */
async function listApiKeys(): Promise<ApiKey[]> {
  const res = await apiRequest<ApiKeyListResponse>("/api-keys");
  return res.apiKeys ?? [];
}

export function apiKeysQuery() {
  return queryOptions({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: listApiKeys,
  });
}

/** Full secret. Never cache. */
export function getApiKey(id: string): Promise<ApiKeyDetailResponse> {
  return apiRequest(keyPath(id));
}

export function createApiKey(req: ApiKeyCreateRequest): Promise<ApiKeyCreateResponse> {
  return apiRequest("/api-keys", { method: "POST", body: req });
}

/** 409 `api_key_lockout` when it disables the last enabled key while keys are required. */
export function updateApiKey(id: string, req: ApiKeyUpdateRequest): Promise<ApiKeyUpdateResponse> {
  return apiRequest(keyPath(id), { method: "PUT", body: req });
}

/** 409 `api_key_lockout` when it deletes the last enabled key while keys are required. */
export function deleteApiKey(id: string): Promise<SuccessResponse> {
  return apiRequest(keyPath(id), { method: "DELETE" });
}

export function resetApiKeyUsage(id: string): Promise<ApiKeyResetUsageResponse> {
  return apiRequest(keyPath(id, "/reset-usage"), { method: "POST" });
}

/** A fresh secret for the key; the old one stops working at once. */
export function regenerateApiKey(id: string): Promise<ApiKeyRegenerateResponse> {
  return apiRequest(keyPath(id, "/regenerate"), { method: "POST" });
}
