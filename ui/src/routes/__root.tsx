import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import { type JSX, useEffect, useRef } from "react";
import { NotFound } from "@/components/layout/not-found";
import { ErrorState } from "@/components/shared/error-state";
import { subscribeSession } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function RootComponent(): JSX.Element {
  useSessionRedirects();
  return <Outlet />;
}

/**
 * One subscription for the app: an expired session toasts once and goes to sign-in;
 * sign-out and backup restore go to sign-in silently (their callers toast); a password
 * change keeps the user where they are.
 */
function useSessionRedirects(): void {
  const router = useRouter();
  const { t } = useT();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(
    () =>
      subscribeSession((_session, reason) => {
        if (reason === "expired") {
          toast.warning(tRef.current("errors:sessionExpired"), { id: "session-expired" });
          void router.navigate({ to: "/login" });
          return;
        }
        if (reason === "signout" || reason === "restored") {
          void router.navigate({ to: "/login" });
        }
      }),
    [router],
  );
}

function RootError({ error }: ErrorComponentProps): JSX.Element {
  const router = useRouter();
  return (
    <main className="flex min-h-svh items-center justify-center p-4" id="main">
      <ErrorState error={error} onRetry={() => void router.invalidate()} />
    </main>
  );
}
