import { createFileRoute, redirect } from "@tanstack/react-router";
import type { JSX } from "react";
import { useUserSessionRedirects } from "@/features/user-panel/use-user-session-redirects";
import { UserPanelPage } from "@/features/user-panel/user-panel-page";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { isUserSignedIn, useUserToken } from "@/lib/auth/user-session";
import { useT } from "@/lib/i18n";

// Outside the admin guard (_app): the API key holder's own page. It never calls /admin/api.
export const Route = createFileRoute("/user/")({
  beforeLoad: () => {
    if (!isUserSignedIn()) throw redirect({ to: "/user/login", search: {} });
  },
  component: UserPanelRoute,
});

function UserPanelRoute(): JSX.Element | null {
  const { t } = useT("user-panel");
  useDocumentTitle(t("title"));
  useUserSessionRedirects();
  // Sign-out and expiry clear the panel's queries before the redirect lands; unmounting the
  // page at once keeps them from refetching without a token.
  const token = useUserToken();
  if (!token) return null;
  // Keyed by the session: a sign-in with another key in another tab starts the page over, so
  // no range, filter or page of the previous key carries across.
  return <UserPanelPage key={token} />;
}
