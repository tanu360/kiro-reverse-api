import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type {
  EndpointConfig,
  EndpointConfigUpdate,
  ModelMappingsResponse,
  ModelMappingsUpdate,
  PromptFilterConfig,
  PromptFilterUpdate,
  ProxyConfig,
  ProxyConfigUpdate,
  Settings,
  SettingsPatch,
  SuccessResponse,
  ThinkingConfig,
  ThinkingConfigUpdate,
} from "./types";

export function getSettings(): Promise<Settings> {
  return apiRequest("/settings");
}

export function settingsQuery() {
  return queryOptions({ queryKey: queryKeys.settings.general(), queryFn: getSettings });
}

/**
 * Patch semantics. A non-empty `password` revokes every admin session, including this one.
 * 409 `api_key_lockout` when it turns requireApiKey on while no API key is enabled.
 */
export function updateSettings(patch: SettingsPatch): Promise<SuccessResponse> {
  return apiRequest("/settings", { method: "POST", body: patch });
}

export function getThinkingConfig(): Promise<ThinkingConfig> {
  return apiRequest("/thinking");
}

export function thinkingQuery() {
  return queryOptions({ queryKey: queryKeys.settings.thinking(), queryFn: getThinkingConfig });
}

/** Not a patch: the server writes all three fields on every call. */
export function updateThinkingConfig(body: ThinkingConfigUpdate): Promise<SuccessResponse> {
  return apiRequest("/thinking", { method: "POST", body });
}

export async function getModelMappings(): Promise<ModelMappingsResponse> {
  const res = await apiRequest<ModelMappingsResponse>("/model-mappings");
  return { mappings: res.mappings ?? [], defaults: res.defaults ?? [] };
}

export function modelMappingsQuery() {
  return queryOptions({ queryKey: queryKeys.settings.modelMappings(), queryFn: getModelMappings });
}

/** Full replace. A 400 carries `index`, the failing row in the submitted list (-1 = the list). */
export function updateModelMappings(body: ModelMappingsUpdate): Promise<SuccessResponse> {
  return apiRequest("/model-mappings", { method: "POST", body });
}

export function getEndpointConfig(): Promise<EndpointConfig> {
  return apiRequest("/endpoint");
}

export function endpointQuery() {
  return queryOptions({ queryKey: queryKeys.settings.endpoint(), queryFn: getEndpointConfig });
}

export function updateEndpointConfig(body: EndpointConfigUpdate): Promise<SuccessResponse> {
  return apiRequest("/endpoint", { method: "POST", body });
}

export function getProxyConfig(): Promise<ProxyConfig> {
  return apiRequest("/proxy");
}

export function proxyQuery() {
  return queryOptions({ queryKey: queryKeys.settings.proxy(), queryFn: getProxyConfig });
}

export function updateProxyConfig(body: ProxyConfigUpdate): Promise<SuccessResponse> {
  return apiRequest("/proxy", { method: "POST", body });
}

export async function getPromptFilter(): Promise<PromptFilterConfig> {
  const res = await apiRequest<PromptFilterConfig>("/prompt-filter");
  return { ...res, rules: res.rules ?? [] };
}

export function promptFilterQuery() {
  return queryOptions({ queryKey: queryKeys.settings.promptFilter(), queryFn: getPromptFilter });
}

/** Patch semantics: omitted fields keep their value, `rules: []` clears every rule. */
export function updatePromptFilter(body: PromptFilterUpdate): Promise<SuccessResponse> {
  return apiRequest("/prompt-filter", { method: "POST", body });
}

/** Irreversible: clears request history, errors and observe counters. */
export function resetStats(): Promise<SuccessResponse> {
  return apiRequest("/stats/reset", { method: "POST" });
}
