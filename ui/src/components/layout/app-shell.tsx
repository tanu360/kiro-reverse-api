import { useRouterState } from "@tanstack/react-router";
import type { CSSProperties, JSX, ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AppSidebar } from "./app-sidebar";
import { useToastPathSync } from "./app-toasts";
import { activeNavItem } from "./nav-items";
import { SiteHeader } from "./site-header";
import { UpdateCheckProvider } from "./update-check";

// 232 px sidebar: the narrowest that keeps the English footer (version, status, GitHub) on one
// line; every nav row, the longest tree row "Needs attention" included, fits with room to spare.
const SIDEBAR_STYLE = { "--sidebar-width": "calc(var(--spacing) * 58)" } as CSSProperties;

const PAGE_FADE_CLASS = "pointer-events-none sticky z-15 h-4 shrink-0 from-background md:h-6";

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeNavItem(pathname);
  useDocumentTitle(active ? t(active.labelKey) : null);
  useToastPathSync();
  return (
    <UpdateCheckProvider>
      <SidebarProvider style={SIDEBAR_STYLE}>
        <a
          className="sr-only z-50 rounded-lg bg-background font-medium text-sm shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-3 focus:py-2 focus-outline"
          href="#main"
        >
          {t("shell.skipToContent")}
        </a>
        <AppSidebar />
        {/* A plain canvas, no grain: t3code's page reads as flat black (#000) or near-white. */}
        <div
          className="relative flex w-full min-w-0 flex-1 flex-col overflow-x-clip bg-background"
          data-slot="sidebar-inset"
        >
          <SiteHeader />
          {/*
           * Scroll edges: the page fades into the canvas under the sticky header and at the
           * window's bottom edge. Each fade is as tall as main's padding, so at rest it covers
           * only padding and content fades only while it scrolls past. z-15 sits above in-card
           * layers (z-10 tab indicators) and below the batch bar (z-20) and the header (z-40).
           */}
          <div
            aria-hidden="true"
            className={cn(PAGE_FADE_CLASS, "top-12 -mb-4 bg-linear-to-b md:-mb-6")}
          />
          <main
            className="mx-auto flex w-full min-w-0 max-w-screen-2xl flex-1 flex-col gap-4 overflow-x-clip p-4 outline-none md:gap-6 md:p-6"
            id="main"
            tabIndex={-1}
          >
            {children}
          </main>
          <div
            aria-hidden="true"
            className={cn(PAGE_FADE_CLASS, "bottom-0 -mt-4 bg-linear-to-t md:-mt-6")}
          />
        </div>
      </SidebarProvider>
    </UpdateCheckProvider>
  );
}
