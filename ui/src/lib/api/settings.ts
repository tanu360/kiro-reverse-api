import { queryOptions } from "@tanstack/react-query";
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

const notImplemented = () => Promise.reject(new Error("not implemented"));

export function getSettings(): Promise<Settings> {
  return notImplemented();
}

export function settingsQuery() {
  return queryOptions({ queryKey: queryKeys.settings.general(), queryFn: getSettings });
}

export function updateSettings(_patch: SettingsPatch): Promise<SuccessResponse> {
  return notImplemented();
}

export function getThinkingConfig(): Promise<ThinkingConfig> {
  return notImplemented();
}

export function thinkingQuery() {
  return queryOptions({ queryKey: queryKeys.settings.thinking(), queryFn: getThinkingConfig });
}

export function updateThinkingConfig(_body: ThinkingConfigUpdate): Promise<SuccessResponse> {
  return notImplemented();
}

export function getModelMappings(): Promise<ModelMappingsResponse> {
  return notImplemented();
}

export function modelMappingsQuery() {
  return queryOptions({ queryKey: queryKeys.settings.modelMappings(), queryFn: getModelMappings });
}

export function updateModelMappings(_body: ModelMappingsUpdate): Promise<SuccessResponse> {
  return notImplemented();
}

export function getEndpointConfig(): Promise<EndpointConfig> {
  return notImplemented();
}

export function endpointQuery() {
  return queryOptions({ queryKey: queryKeys.settings.endpoint(), queryFn: getEndpointConfig });
}

export function updateEndpointConfig(_body: EndpointConfigUpdate): Promise<SuccessResponse> {
  return notImplemented();
}

export function getProxyConfig(): Promise<ProxyConfig> {
  return notImplemented();
}

export function proxyQuery() {
  return queryOptions({ queryKey: queryKeys.settings.proxy(), queryFn: getProxyConfig });
}

export function updateProxyConfig(_body: ProxyConfigUpdate): Promise<SuccessResponse> {
  return notImplemented();
}

export function getPromptFilter(): Promise<PromptFilterConfig> {
  return notImplemented();
}

export function promptFilterQuery() {
  return queryOptions({ queryKey: queryKeys.settings.promptFilter(), queryFn: getPromptFilter });
}

export function updatePromptFilter(_body: PromptFilterUpdate): Promise<SuccessResponse> {
  return notImplemented();
}

export function resetStats(): Promise<SuccessResponse> {
  return notImplemented();
}
