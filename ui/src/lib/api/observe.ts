import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import { getRecentRequests } from "./requests";
import type {
  HeatmapData,
  HeatmapResponse,
  ModelMixEntry,
  ModelMixResponse,
  ObserveError,
  ObserveOverview,
  RecentErrorsResponse,
} from "./types";

export function getObserveOverview(): Promise<ObserveOverview> {
  return apiRequest("/observe/overview");
}

/** `accounts` is null on the wire when no account has traffic; it is always an array here. */
export async function getAccountHeatmap(windowMin: number): Promise<HeatmapData> {
  const res = await apiRequest<HeatmapResponse>("/observe/account-heatmap", {
    query: { windowMin },
  });
  return { ...res, accounts: res.accounts ?? [] };
}

export async function getModelMix(): Promise<ModelMixEntry[]> {
  const res = await apiRequest<ModelMixResponse>("/observe/model-mix");
  return res.models ?? [];
}

export async function getRecentErrors(limit: number): Promise<ObserveError[]> {
  const res = await apiRequest<RecentErrorsResponse>("/observe/recent-errors", {
    query: { limit },
  });
  return res.errors ?? [];
}

export function observeOverviewQuery() {
  return queryOptions({
    queryKey: queryKeys.observe.overview(),
    queryFn: getObserveOverview,
  });
}

/** live: false => meta.liveRefresh = false (SSE ticks skip it) and a 60 s poll instead. */
export function heatmapQuery(windowMin: number, options?: { live?: boolean }) {
  const live = options?.live ?? true;
  return queryOptions({
    queryKey: queryKeys.observe.heatmap(windowMin),
    queryFn: () => getAccountHeatmap(windowMin),
    ...(live ? {} : { meta: { liveRefresh: false }, refetchInterval: 60_000 }),
  });
}

export function modelMixQuery() {
  return queryOptions({
    queryKey: queryKeys.observe.modelMix(),
    queryFn: getModelMix,
  });
}

export function recentErrorsQuery(limit: number) {
  return queryOptions({
    queryKey: queryKeys.observe.recentErrors(limit),
    queryFn: () => getRecentErrors(limit),
  });
}

/** Overview's recent-activity preview: page 1 of the requests list under an observe key. */
export function recentRequestsPreviewQuery(pageSize: number) {
  return queryOptions({
    queryKey: queryKeys.observe.recentRequests(pageSize),
    queryFn: () => getRecentRequests({ page: 1, pageSize }),
  });
}
