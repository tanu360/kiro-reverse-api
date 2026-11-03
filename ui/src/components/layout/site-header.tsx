import { useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { CommandMenu } from "./command-menu";
import { LanguageSwitch } from "./language-switch";
import { activeNavItem } from "./nav-items";
import { PrivacyToggle } from "./privacy-toggle";
import { ThemeSwitch } from "./theme-switch";
import { UpdateIndicator } from "./update-indicator";
import { UserMenu } from "./user-menu";

/** Port of the Studio Admin dashboard header: sticky, 48 px, blurred. */
export function SiteHeader(): JSX.Element {
  const { t } = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeNavItem(pathname);
  const toggleLabel = t("shell.toggleSidebar");

  return (
    <header
      className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b bg-background/50 backdrop-blur-md"
      data-slot="site-header"
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2 px-2 sm:px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-1 lg:gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarTrigger aria-label={toggleLabel} className="-ml-1 size-10 lg:size-8" />
              }
            />
            <TooltipPopup>{toggleLabel}</TooltipPopup>
          </Tooltip>
          <Separator className="mx-1 h-4 self-center sm:mx-2" orientation="vertical" />
          {active ? (
            <span className="truncate font-medium text-sm" data-slot="page-title">
              {t(active.labelKey)}
            </span>
          ) : null}
          <CommandMenu />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <UpdateIndicator />
          <PrivacyToggle />
          <LanguageSwitch />
          <ThemeSwitch />
          <div className="hidden sm:flex">
            <UserMenu variant="header" />
          </div>
        </div>
      </div>
    </header>
  );
}
