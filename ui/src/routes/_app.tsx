import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { JSX } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { isAuthenticated } from "@/lib/auth/session";
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

function AppLayout(): JSX.Element {
  return (
    <AdminEventsProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </AdminEventsProvider>
  );
}
