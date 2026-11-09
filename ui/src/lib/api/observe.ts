import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type {
  HeatmapCell,
  HeatmapData,
  HeatmapResponse,
  ModelMixEntry,
  ModelMixResponse,
  ObserveOverview,
} from "./types";

function getObserveOverview(): Promise<ObserveOverview> {
  return apiRequest("/observe/overview");
}

/** Optional shaping for /observe/account-heatmap. Leaving all of them out keeps every account. */
interface HeatmapParams {
  /** "global" leaves the accounts out, for views that read only the global row. */
  scope?: "global" | "all";
  /** Only the N busiest accounts over the last hour, busiest first; `restCount` counts the rest. */
  top?: number;
  /** Minutes summed per cell (default 1); offset N then means N buckets ago. */
  bucketMin?: number;
}

/** Fills the cells a sparse row left out, so every row has one cell per bucket, offset 0 first. */
function densify(cells: readonly HeatmapCell[], count: number): HeatmapCell[] {
  const dense: HeatmapCell[] = Array.from({ length: count }, (_, offset) => ({
    offset,
    reqs: 0,
    failures: 0,
  }));
  for (const cell of cells) {
    if (cell.offset >= 0 && cell.offset < count) dense[cell.offset] = cell;
  }
  return dense;
}

/**
 * Asks for sparse rows (only cells with traffic travel) and returns them dense, so callers get
 * the same shape as before. `accounts` is left out or null on the wire when there is none; it is
 * always an array here.
 */
async function getAccountHeatmap(
  windowMin: number,
  params: HeatmapParams = {},
): Promise<HeatmapData> {
  const res = await apiRequest<HeatmapResponse>("/observe/account-heatmap", {
    query: {
      windowMin,
      sparse: 1,
      scope: params.scope === "global" ? "global" : undefined,
      top: params.top && params.top > 0 ? params.top : undefined,
      bucketMin: params.bucketMin && params.bucketMin > 1 ? params.bucketMin : undefined,
    },
  });
  const bucketMin = Math.max(1, res.bucketMin ?? 1);
  const count = Math.ceil(res.windowMin / bucketMin);
  return {
    ...res,
    bucketMin,
    global: { ...res.global, cells: densify(res.global.cells ?? [], count) },
    accounts: (res.accounts ?? []).map((row) => ({
      ...row,
      cells: densify(row.cells ?? [], count),
    })),
  };
}

async function getModelMix(): Promise<ModelMixEntry[]> {
  const res = await apiRequest<ModelMixResponse>("/observe/model-mix");
  return res.models ?? [];
}

/** The SSE poll fallback for the overview: one small JSON a minute, only while the tab is shown. */
const OVERVIEW_POLL_MS = 60_000;

/**
 * observe_tick and the account / settings events keep the overview current; the 60 s poll
 * covers a dropped event stream, so the live tiles never freeze for long.
 */
export function observeOverviewQuery() {
  return queryOptions({
    queryKey: queryKeys.observe.overview(),
    queryFn: getObserveOverview,
    refetchInterval: OVERVIEW_POLL_MS,
  });
}

/**
 * live: false => meta.liveRefresh = false (SSE ticks skip it) and a 60 s poll instead.
 * scope, top and bucketMin shape the response (see HeatmapParams) and are part of the key.
 */
export function heatmapQuery(windowMin: number, options?: { live?: boolean } & HeatmapParams) {
  const { live = true, ...params } = options ?? {};
  return queryOptions({
    queryKey: queryKeys.observe.heatmap(windowMin, params),
    queryFn: () => getAccountHeatmap(windowMin, params),
    ...(live ? {} : { meta: { liveRefresh: false }, refetchInterval: 60_000 }),
  });
}

export function modelMixQuery() {
  return queryOptions({
    queryKey: queryKeys.observe.modelMix(),
    queryFn: getModelMix,
  });
}
