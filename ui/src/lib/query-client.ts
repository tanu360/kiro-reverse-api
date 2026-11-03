import { QueryClient } from "@tanstack/react-query";

/** Skeleton: Task 3 sets the retry, focus-refetch and stale-time defaults. */
export function createAppQueryClient(): QueryClient {
  return new QueryClient();
}

export const queryClient: QueryClient = createAppQueryClient();
