import { PlusIcon } from "@hugeicons/core-free-icons";
import { Link, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { activeNavItem, NAV_GROUPS, NAV_ITEMS } from "./nav-items";

/**
 * Port of Studio Admin nav-main: an "Add account" action, then the grouped pages, one row each.
 * A page's views and sub-pages (Accounts › Needs attention, Settings › Server) are its own tabs,
 * so its row stays selected on any of them.
 */
export function NavMain(): JSX.Element {
  const { t } = useT();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = activeNavItem(pathname);
  // The mobile sheet closes once a page is picked.
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="h-9 min-w-8 group-data-[collapsible=icon]:gap-0"
                onClick={closeOnMobile}
                render={<Link search={{ add: true }} to="/accounts" />}
                tooltip={t("shell.addAccount")}
                variant="outline"
              >
                <AnimatedIcon icon={PlusIcon} aria-hidden="true" />
                <span>{t("shell.addAccount")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {NAV_GROUPS.map((group) => (
        <SidebarGroup key={group}>
          {/* The rail hides the label by fading it over the row above; keep it out of hit-testing. */}
          <SidebarGroupLabel className="text-2xs uppercase tracking-wider group-data-[collapsible=icon]:pointer-events-none">
            {t(`nav.group.${group}`)}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
                const label = t(item.labelKey);
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      className="h-9"
                      isActive={active?.id === item.id}
                      onClick={closeOnMobile}
                      render={<Link to={item.to} />}
                      tooltip={label}
                    >
                      <AnimatedIcon icon={item.icon} aria-hidden="true" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}
