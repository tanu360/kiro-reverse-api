import { PlusIcon } from "@hugeicons/core-free-icons";
import { Link, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { activeNavItem, activeNavView, NAV_GROUPS, NAV_ITEMS } from "./nav-items";

/**
 * Port of Studio Admin nav-main: an "Add account" action, then the grouped pages. A page with
 * filtered views (Requests, Accounts) or sub-pages (Settings) carries them as a tree under its
 * row, unfolded only while that page is open. The page row is selected only when none of its
 * views is.
 */
export function NavMain(): JSX.Element {
  const { t } = useT();
  const { isMobile, setOpenMobile, state } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const status = useRouterState({
    select: (s) => (s.location.search as { status?: unknown }).status,
  });
  const active = activeNavItem(pathname);
  // The icon rail hides the trees, so there the page row stays selected on any of its views.
  const rail = state === "collapsed" && !isMobile;
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
                className="min-w-8 group-data-[collapsible=icon]:gap-0"
                onClick={closeOnMobile}
                render={<Link search={{ add: true }} to="/accounts" />}
                tooltip={t("shell.addAccount")}
                variant="primary"
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
          <SidebarGroupLabel className="group-data-[collapsible=icon]:pointer-events-none">
            {t(`nav.group.${group}`)}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
                const label = t(item.labelKey);
                const onPage = active?.id === item.id;
                const view = onPage ? activeNavView(item, status, pathname) : undefined;
                // Only the open page's tree unfolds.
                const open = onPage;
                const button = (
                  <SidebarMenuButton
                    aria-expanded={item.views && !rail ? open : undefined}
                    // An unfolded page row heads its tree: label and icon in full colour.
                    className="aria-expanded:text-sidebar-foreground aria-expanded:[&>svg]:text-sidebar-foreground"
                    isActive={onPage && (rail || !view)}
                    onClick={closeOnMobile}
                    render={<Link to={item.to} />}
                    tooltip={label}
                  >
                    <AnimatedIcon icon={item.icon} aria-hidden="true" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                );
                if (!item.views) {
                  return <SidebarMenuItem key={item.id}>{button}</SidebarMenuItem>;
                }
                return (
                  <Collapsible key={item.id} open={open} render={<SidebarMenuItem />}>
                    {button}
                    <CollapsiblePanel className="group-data-[collapsible=icon]:hidden">
                      <SidebarMenuSub>
                        {item.views.map((sub) => (
                          <SidebarMenuSubItem key={sub.id}>
                            <SidebarMenuSubButton
                              isActive={view?.id === sub.id}
                              onClick={closeOnMobile}
                              render={
                                "status" in sub ? (
                                  <Link search={{ status: sub.status }} to={sub.to} />
                                ) : (
                                  <Link to={sub.to} />
                                )
                              }
                            >
                              <span>{t(sub.labelKey)}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsiblePanel>
                  </Collapsible>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}
