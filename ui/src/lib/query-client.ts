import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/api/errors";
import { subscribeSession } from "@/lib/auth/session";

/** Retrying a 4xx cannot change the answer; network errors and 5xx get two more tries. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        refetchOnWindowFocus: true,
        staleTime: 5_000,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export const queryClient: QueryClient = createAppQueryClient();

// Signing out, expiry or a restore must not leave the previous session's data in the cache.
subscribeSession((session) => {
  if (!session) queryClient.clear();
});
