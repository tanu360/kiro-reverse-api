import { createFileRoute, redirect } from "@tanstack/react-router";
import type { JSX } from "react";
import { userRedirectTarget, validateUserLoginSearch } from "@/features/user-auth/redirect";
import { UserLoginPage } from "@/features/user-auth/user-login-page";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { isUserSignedIn } from "@/lib/auth/user-session";
import { useT } from "@/lib/i18n";

// Outside the admin guard (_app): an API key holder signs in here without the admin password.
export const Route = createFileRoute("/user/login")({
  validateSearch: validateUserLoginSearch,
  beforeLoad: ({ search }) => {
    if (isUserSignedIn()) {
      const { to, search: targetSearch } = userRedirectTarget(search.redirect);
      throw redirect({ to, search: () => targetSearch });
    }
  },
  component: UserLoginRoute,
});

function UserLoginRoute(): JSX.Element {
  const { t } = useT("user-auth");
  const { redirect: target } = Route.useSearch();
  useDocumentTitle(t("title"));
  return <UserLoginPage redirect={target} />;
}
