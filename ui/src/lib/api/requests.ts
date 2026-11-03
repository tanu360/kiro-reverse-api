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
      sort: params.sort,
      order: params.order,
    },
  });
  return { ...res, requests: res.requests ?? [] };
}

export function recentRequestsQuery(params: RecentRequestsParams) {
  return queryOptions({
    queryKey: queryKeys.requests.list(params),
    queryFn: () => getRecentRequests(params),
    placeholderData: keepPreviousData,
  });
}
