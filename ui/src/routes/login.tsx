import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";
import { LoginPage } from "@/features/auth/login-page";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated } from "@/lib/auth/session";
import { redirectTarget, validateLoginSearch } from "./-search";

export const Route = createFileRoute("/login")({
  validateSearch: validateLoginSearch,
  beforeLoad: ({ search }) => {
    if (isAuthenticated()) {
      const { to, search: targetSearch } = redirectTarget(search.redirect);
      throw redirect({ to, search: () => targetSearch });
    }
  },
  loader: async ({ context }) => {
    try {
      const { password } = await context.queryClient.fetchQuery(firstRunQuery());
      // A pending first run shows its generated password on /setup instead.
      if (password) throw redirect({ to: "/setup" });
    } catch (error) {
      if (isRedirect(error)) throw error;
      // A network error still renders the sign-in page.
    }
  },
  component: LoginPage,
});
