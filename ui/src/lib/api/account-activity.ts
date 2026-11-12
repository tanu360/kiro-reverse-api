import { queryOptions, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";

/** One account's live numbers. Counts are final client requests: a retried request counts once. */
export interface AccountActivity {
  /** Requests since midnight in the server's time zone, success or failure. */
  today: number;
  /** Requests finished in the last 60 seconds. */
  rpm: number;
  /** The account started `rpmLimit` requests in the last minute; the pool skips it for now. */
  atLimit: boolean;
}

/** GET /admin/api/observe/account-activity: every configured account, zeros when idle. */
export interface AccountActivityResponse {
  /** unix s */
  nowUnix: number;
  /** unix s of the server's local midnight that began today */
  dayStartUnix: number;
  /** The per-account requests-per-minute limit; 0 means off. */
  rpmLimit: number;
  accounts: Record<string, AccountActivity>;
}

/** One account's numbers with the limit they are measured against. */
export interface AccountActivityView extends AccountActivity {
  rpmLimit: number;
}

/** The live RPM moves every second, so the numbers poll on their own. */
export const ACCOUNT_ACTIVITY_POLL_MS = 5000;

const IDLE: AccountActivity = { today: 0, rpm: 0, atLimit: false };

function getAccountActivity(): Promise<AccountActivityResponse> {
  return apiRequest("/observe/account-activity");
}

/**
 * Polled every 5 s while the page is shown. meta.liveRefresh = false: observe_tick (every
 * request) does not refetch it on top of the poll. Under the observe key, so a stats reset
 * still refetches it at once.
 */
export function accountActivityQuery() {
  return queryOptions({
    queryKey: queryKeys.observe.accountActivity(),
    queryFn: getAccountActivity,
    refetchInterval: ACCOUNT_ACTIVITY_POLL_MS,
    meta: { liveRefresh: false },
  });
}

/**
 * One account's slice of the shared poll. Every row reads the same query, and the selected slice
 * keeps its identity while its numbers stay the same, so a poll re-renders only the rows whose
 * numbers moved. An account the server has not listed yet (just added) reads as idle.
 */
export function useAccountActivity(accountId: string) {
  const select = useCallback(
    (data: AccountActivityResponse): AccountActivityView => ({
      ...(data.accounts?.[accountId] ?? IDLE),
      rpmLimit: data.rpmLimit ?? 0,
    }),
    [accountId],
  );
  return useQuery({ ...accountActivityQuery(), select });
}
