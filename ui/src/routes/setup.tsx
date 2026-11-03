import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";
import type { JSX } from "react";
import { SetupPage } from "@/features/auth/setup-page";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/setup")({
  beforeLoad: () => {
    if (isAuthenticated()) throw redirect({ to: "/" });
  },
  loader: async ({ context }) => {
    try {
      // Fetched fresh on every visit: someone else may have signed in since.
      const { password } = await context.queryClient.fetchQuery(firstRunQuery());
      if (!password) throw redirect({ to: "/login" });
    } catch (error) {
      if (isRedirect(error)) throw error;
      // A network error still renders the page and its sign-in form.
    }
  },
  component: SetupPageRoute,
});

function SetupPageRoute(): JSX.Element {
  const { t } = useT();
  useDocumentTitle(t("shell.page.setup"));
  return <SetupPage />;
}
