import { Link, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { CommandMenuProvider, CommandMenuTrigger } from "./command-menu";
import { LanguageSwitch } from "./language-switch";
import { activeNavItem, activeNavView, type NavItem, type NavView } from "./nav-items";
import { PrivacyToggle } from "./privacy-toggle";
import { ThemeSwitch } from "./theme-switch";

/**
 * Port of the Studio Admin dashboard header: sticky and 48 px, painted like t3code's page headers
 * (solid `bg-background` as in ChatView's `data-chat-header`, with the `h-12 border-b` of its
 * settings content header) rather than a translucent blur. Like the page under it, it has no
 * grain (t3code's canvas measures flat), so the bar and the page read as one surface.
 *
 * Its row shares the page's column (`max-w-screen-2xl`, the `px-4 md:px-6` gutter), and the
 * first and last icon buttons sit out by their glyph's inset, so the panel toggle's glyph lines
 * up with the page title and the last header glyph with the page's right edge.
 */
export function SiteHeader(): JSX.Element {
  const { t } = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const status = useRouterState({
    select: (state) => (state.location.search as { status?: unknown }).status,
  });
  const active = activeNavItem(pathname);
  const view = active ? activeNavView(active, status, pathname) : undefined;
  const toggleLabel = t("shell.toggleSidebar");

  return (
    <header
      className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b bg-background"
      data-slot="site-header"
    >
      <CommandMenuProvider>
        {/*
         * Phones: the trail, then the icon cluster with search first. From sm up, three columns
         * with the search field centred in the middle one (up to 320 px wide). The side columns
         * never drop below their content, so the search field narrows before the trail truncates.
         */}
        <div className="mx-auto grid w-full min-w-0 max-w-screen-2xl grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 sm:grid-cols-[minmax(max-content,1fr)_minmax(0,20rem)_minmax(max-content,1fr)] md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarTrigger
                    aria-label={toggleLabel}
                    className="-ms-2 pointer-coarse:-ms-2.5"
                  />
                }
              />
              <TooltipPopup>{toggleLabel}</TooltipPopup>
            </Tooltip>
            <Separator
              className="-ms-1 me-1 h-4 self-center max-sm:hidden"
              orientation="vertical"
            />
            {active ? <PageTrail item={active} view={view} /> : null}
          </div>
          <div className="hidden min-w-0 justify-center sm:flex">
            <CommandMenuTrigger />
          </div>
          <div className="-me-2 flex shrink-0 items-center justify-end gap-0.5 pointer-coarse:-me-2.5 sm:gap-1">
            <CommandMenuTrigger className="sm:hidden" variant="icon" />
            <PrivacyToggle />
            {/*
             * Phones: hidden, to leave the page title room beside the touch icons. Language stays
             * one tap away in the ⌘K palette (its Language group).
             */}
            <LanguageSwitch className="max-sm:hidden" />
            <ThemeSwitch variant="menu" />
          </div>
        </div>
      </CommandMenuProvider>
    </header>
  );
}

/**
 * Where the page sits: its sidebar group, the page, and the sidebar view when one is open
 * (Accounts › Needs attention). Below xl only the current page shows, so the page name never
 * truncates away behind its parent crumbs on tablet widths.
 */
function PageTrail({ item, view }: { item: NavItem; view: NavView | undefined }): JSX.Element {
  const { t } = useT();
  const page = t(item.labelKey);
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="shrink-0 max-xl:hidden">
          {t(`nav.group.${item.group}`)}
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-xl:hidden">/</BreadcrumbSeparator>
        {view ? (
          <>
            <BreadcrumbItem className="shrink-0 max-xl:hidden">
              <BreadcrumbLink render={<Link to={item.to} />}>{page}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-xl:hidden">/</BreadcrumbSeparator>
          </>
        ) : null}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate font-medium" data-slot="page-title">
            {view ? t(view.labelKey) : page}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
