import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";
import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthHeader, AuthLayout } from "@/features/auth/auth-layout";
import { LoginPage } from "@/features/auth/login-page";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { redirectTarget, validateLoginSearch } from "./-search";

export const Route = createFileRoute("/login")({
  validateSearch: validateLoginSearch,
  beforeLoad: ({ search }) => {
    if (isAuthenticated()) {
      const { to, search: targetSearch } = redirectTarget(search.redirect);
      throw redirect({ to, search: () => targetSearch });
    }
  },
  loaderDeps: ({ search }) => ({ redirect: search.redirect }),
  loader: async ({ context, deps }) => {
    try {
      const { password } = await context.queryClient.fetchQuery(firstRunQuery());
      // A pending first run shows its generated password on /setup instead.
      if (password) throw redirect({ to: "/setup", search: { redirect: deps.redirect } });
    } catch (error) {
      if (isRedirect(error)) throw error;
      // A network error still renders the sign-in page.
    }
  },
  // While a slow first-run check holds the loader, the sign-in frame shows with the form as
  // skeleton bars instead of a blank page.
  pendingMs: 200,
  pendingComponent: LoginPendingRoute,
  component: LoginPageRoute,
});

function LoginPageRoute(): JSX.Element {
  const { t } = useT();
  useDocumentTitle(t("shell.page.login"));
  return <LoginPage />;
}

/** The sign-in page while its route loads: the same frame and heading, the form as bars. */
function LoginPendingRoute(): JSX.Element {
  const { t } = useT();
  const { t: tAuth } = useT("auth");
  useDocumentTitle(t("shell.page.login"));
  return (
    <AuthLayout>
      <AuthHeader description={tAuth("subtitle")} title={tAuth("title")} />
      <div aria-busy="true" className="flex flex-col gap-4" role="status">
        <span className="sr-only">{t("state.loading")}</span>
        {/* The password field and the sign-in button, at their heights (lg: 44 / 40 px). */}
        <Skeleton className="h-11 sm:h-10" />
        <Skeleton className="h-11 sm:h-10" />
        {/* The "Stay signed in" row under the button. */}
        <div className="-mt-3 flex min-h-10 items-center">
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    </AuthLayout>
  );
}
