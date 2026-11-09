import { useQuery } from "@tanstack/react-query";
import { observeOverviewQuery } from "@/lib/api/observe";
import { statusQuery } from "@/lib/api/system";

/**
 * True while /status or /observe/overview has failed: the page shows one error banner with the
 * Retry for every card, and the section cards drop their own error blocks to a quiet
 * "Not loaded" line.
 */
export function useTotalsFailed(): boolean {
  // Same query keys as the page banner, so these observers add no requests.
  const status = useQuery(statusQuery());
  const live = useQuery(observeOverviewQuery());
  return status.isError || live.isError;
}
