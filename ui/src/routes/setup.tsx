import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";
import { SetupPage } from "@/features/auth/setup-page";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated } from "@/lib/auth/session";

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
  component: SetupPage,
});
