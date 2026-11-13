import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { RecentRequestsParams, RecentRequestsResponse } from "./types";

/** Empty `search`/`status` are left out of the query string, like the old UI. */
export async function getRecentRequests(
  params: RecentRequestsParams,
): Promise<RecentRequestsResponse> {
  const res = await apiRequest<RecentRequestsResponse>("/observe/recent-requests", {
    query: {
      page: params.page,
      pageSize: params.pageSize,
      search: params.search?.trim(),
      status: params.status,
      errorType: params.errorType,
      sort: params.sort,
      order: params.order,
    },
  });
  return { ...res, requests: res.requests ?? [] };
}

export interface RequestCounts {
  success: number;
  failed: number;
}

/**
 * Requests per status in the whole log (the search does not narrow it), for the Requests tabs:
 * the totals of a one-row page of each status.
 */
export function requestCountsQuery() {
  return queryOptions({
    queryKey: queryKeys.requests.counts(),
    queryFn: async (): Promise<RequestCounts> => {
      const [success, failed] = await Promise.all([
        getRecentRequests({ page: 1, pageSize: 1, status: "success" }),
        getRecentRequests({ page: 1, pageSize: 1, status: "failed" }),
      ]);
      return { success: success.total, failed: failed.total };
    },
  });
}

export function recentRequestsQuery(params: RecentRequestsParams) {
  return queryOptions({
    queryKey: queryKeys.requests.list(params),
    queryFn: () => getRecentRequests(params),
    placeholderData: keepPreviousData,
  });
}
