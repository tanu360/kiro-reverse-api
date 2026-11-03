import { Link, useRouterState } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import type { JSX } from "react";
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
 * Port of Studio Admin nav-main: an "Add account" action, then the grouped pages. The action is
 * a quiet outline row, as t3code styles its sidebar header actions.
 */
export function NavMain(): JSX.Element {
  const { t } = useT();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
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
                className="min-w-8"
                onClick={closeOnMobile}
                render={<Link search={{ add: true }} to="/accounts" />}
                tooltip={t("shell.addAccount")}
                variant="outline"
              >
                <PlusIcon aria-hidden="true" />
                <span>{t("shell.addAccount")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {NAV_GROUPS.map((group) => (
        <SidebarGroup key={group}>
          <SidebarGroupLabel>{t(`nav.group.${group}`)}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
                const label = t(item.labelKey);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={active?.id === item.id}
                      onClick={closeOnMobile}
                      render={<Link to={item.to} />}
                      tooltip={label}
                    >
                      <Icon aria-hidden="true" />
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
