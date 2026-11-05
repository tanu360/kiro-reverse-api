import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";
import type { JSX } from "react";
import { SetupPage } from "@/features/auth/setup-page";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { redirectTarget, validateLoginSearch } from "./-search";

export const Route = createFileRoute("/setup")({
  validateSearch: validateLoginSearch,
  beforeLoad: ({ search }) => {
    if (isAuthenticated()) {
      const target = redirectTarget(search.redirect);
      throw redirect({ to: target.to, search: () => target.search });
    }
  },
  loaderDeps: ({ search }) => ({ redirect: search.redirect }),
  loader: async ({ context, deps }) => {
    try {
      // Fetched fresh on every visit: someone else may have signed in since.
      const { password } = await context.queryClient.fetchQuery(firstRunQuery());
      if (!password) throw redirect({ to: "/login", search: { redirect: deps.redirect } });
    } catch (error) {
      if (isRedirect(error)) throw error;
      // A network error still renders the page and its sign-in form.
    }
  },
  // While a slow first-run check holds the loader, the page itself shows: it reads the same
  // query, so its password row is the loading skeleton until the answer comes.
  pendingMs: 200,
  pendingComponent: SetupPageRoute,
  component: SetupPageRoute,
});

function SetupPageRoute(): JSX.Element {
  const { t } = useT();
  useDocumentTitle(t("shell.page.setup"));
  return <SetupPage />;
}
