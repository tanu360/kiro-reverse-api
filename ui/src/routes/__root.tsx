import { CircleXIcon, LayoutDashboardIcon, RefreshCwIcon } from "@hugeicons/core-free-icons";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  Link,
  Outlet,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { type JSX, useEffect, useRef } from "react";
import { NotFound } from "@/components/layout/not-found";
import { StatusPage } from "@/components/layout/status-page";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/errors";
import { errorMessage } from "@/lib/api/server-errors";
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
          const location = router.state.location;
          void router.navigate({
            to: "/login",
            search: { redirect: location.pathname + location.searchStr },
            replace: true,
          });
          return;
        }
        if (reason === "signout" || reason === "restored") {
          void router.navigate({ to: "/login" });
        }
      }),
    [router],
  );
}

/**
 * A route that failed to load or render. A server answer shows its own message (and status
 * code); anything else keeps to the generic line, so no stack text reaches the page. "Go to
 * Overview" is left out when Overview is the page that failed.
 */
function RootError({ error }: ErrorComponentProps): JSX.Element {
  const router = useRouter();
  const { t } = useT();
  const pathname = useLocation({ select: (location) => location.pathname });
  const apiError = isApiError(error) ? error : null;

  return (
    <StatusPage
      description={t("shell.error.description")}
      eyebrow={
        apiError && apiError.status > 0
          ? t("shell.errorCode", { code: apiError.status })
          : undefined
      }
      title={t("shell.error.title")}
    >
      {apiError ? (
        <Alert className="mb-1" variant="error">
          <AnimatedIcon icon={CircleXIcon} aria-hidden="true" playOnMount />
          <AlertDescription className="break-words">{errorMessage(apiError, t)}</AlertDescription>
        </Alert>
      ) : null}
      <Button className="w-full" onClick={() => void router.invalidate()} size="lg">
        <AnimatedIcon icon={RefreshCwIcon} aria-hidden="true" />
        {t("actions.retry")}
      </Button>
      {pathname === "/" ? null : (
        <Button className="w-full" render={<Link to="/" />} size="lg" variant="outline">
          <AnimatedIcon icon={LayoutDashboardIcon} aria-hidden="true" />
          {t("shell.notFound.action")}
        </Button>
      )}
    </StatusPage>
  );
}
