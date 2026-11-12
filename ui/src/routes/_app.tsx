import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { JSX } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { AccountHealNotices } from "@/features/settings/account-heal-notices";
import { isAuthenticated, useSession } from "@/lib/auth/session";
import { AdminEventsProvider } from "@/lib/events/admin-events";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ location }) => {
    if (!isAuthenticated()) {
      // The redirect value keeps the query string; the login route splits it back out.
      throw redirect({
        to: "/login",
        search: { redirect: location.pathname + location.searchStr },
      });
    }
  },
  component: AppLayout,
});

function AppLayout(): JSX.Element | null {
  // Sign-out, expiry and restore clear the query cache before the redirect to /login lands.
  // Unmounting the pages at once keeps their queries from refetching without a token.
  const session = useSession();
  if (!session) return null;
  return (
    <AdminEventsProvider>
      <AccountHealNotices />
      <AppShell>
        <Outlet />
      </AppShell>
    </AdminEventsProvider>
  );
}
