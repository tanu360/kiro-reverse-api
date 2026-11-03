import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import type { RecentRequestsParams, RecentRequestsResponse } from "./types";

export function getRecentRequests(_params: RecentRequestsParams): Promise<RecentRequestsResponse> {
  return Promise.reject(new Error("not implemented"));
}

export function recentRequestsQuery(params: RecentRequestsParams) {
  return queryOptions({
    queryKey: queryKeys.requests.list(params),
    queryFn: () => getRecentRequests(params),
    placeholderData: keepPreviousData,
  });
}
