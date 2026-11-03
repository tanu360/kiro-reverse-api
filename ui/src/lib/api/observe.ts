import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import { getRecentRequests } from "./requests";
import type { HeatmapData, ModelMixEntry, ObserveError, ObserveOverview } from "./types";

const notImplemented = () => Promise.reject(new Error("not implemented"));

export function getObserveOverview(): Promise<ObserveOverview> {
  return notImplemented();
}

export function getAccountHeatmap(_windowMin: number): Promise<HeatmapData> {
  return notImplemented();
}

export function getModelMix(): Promise<ModelMixEntry[]> {
  return notImplemented();
}

export function getRecentErrors(_limit: number): Promise<ObserveError[]> {
  return notImplemented();
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
