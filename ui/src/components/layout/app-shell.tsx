import { useRouterState } from "@tanstack/react-router";
import type { CSSProperties, JSX, ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";
import { AppSidebar } from "./app-sidebar";
import { activeNavItem } from "./nav-items";
import { SiteHeader } from "./site-header";
import { UpdateCheckProvider } from "./update-check";

// 272 px sidebar, as in Studio Admin.
const SIDEBAR_STYLE = { "--sidebar-width": "calc(var(--spacing) * 68)" } as CSSProperties;

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeNavItem(pathname);
  useDocumentTitle(active ? t(active.labelKey) : null);
  return (
    <UpdateCheckProvider>
      <SidebarProvider style={SIDEBAR_STYLE}>
        <a
          className="sr-only z-50 rounded-md bg-background px-3 py-2 font-medium text-sm shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:outline-none focus:ring-2 focus:ring-ring"
          href="#main"
        >
          {t("shell.skipToContent")}
        </a>
        <AppSidebar />
        <div
          className="relative flex w-full min-w-0 flex-1 flex-col overflow-x-clip bg-background"
          data-slot="sidebar-inset"
        >
          <SiteHeader />
          <main
            className="mx-auto flex w-full min-w-0 max-w-screen-2xl flex-1 flex-col gap-4 overflow-x-clip p-4 outline-none md:gap-6 md:p-6"
            id="main"
            tabIndex={-1}
          >
            {children}
          </main>
        </div>
      </SidebarProvider>
    </UpdateCheckProvider>
  );
}
