import { PlusIcon } from "@hugeicons/core-free-icons";
import { Link, useRouterState } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuChevron,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { readStorage, writeStorage } from "@/lib/storage";
import { activeNavItem, activeNavView, NAV_GROUPS, NAV_ITEMS, type NavItem } from "./nav-items";

// Pages whose views the admin folded away; every tree starts open so rows never jump.
const COLLAPSED_KEY = "kiro_sidebar_collapsed_views";

function readCollapsed(): Set<string> {
  const raw = readStorage(COLLAPSED_KEY);
  return new Set(raw ? raw.split(",").filter(Boolean) : []);
}

/**
 * Port of Studio Admin nav-main: an "Add account" action, then the grouped pages. A page with
 * filtered views (Requests, Accounts) carries them as a tree under its row. The row opens the
 * tree on the way to its page, and folds or unfolds it once already there; the chevron only
 * shows which. The page row is selected only when none of its views is.
 */
export function NavMain(): JSX.Element {
  const { t } = useT();
  const { isMobile, setOpenMobile, state } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const status = useRouterState({
    select: (s) => (s.location.search as { status?: unknown }).status,
  });
  const active = activeNavItem(pathname);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // The icon rail hides the trees, so there the page row stays selected on any of its views.
  const rail = state === "collapsed" && !isMobile;
  // The mobile sheet closes once a page is picked.
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const setOpen = (id: NavItem["id"], open: boolean) => {
    const next = new Set(collapsed);
    if (open) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    writeStorage(COLLAPSED_KEY, next.size ? [...next].join(",") : null);
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
          <SidebarGroupLabel>{t(`nav.group.${group}`)}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
                const label = t(item.labelKey);
                const onPage = active?.id === item.id;
                const view = onPage ? activeNavView(item, status) : undefined;
                const open = !collapsed.has(item.id);
                const onRowClick = () => {
                  // Already on the plain page: the click folds or unfolds its tree, and the
                  // mobile sheet stays open to show it. The rail has no tree to fold.
                  if (item.views && onPage && !view && !rail) {
                    setOpen(item.id, !open);
                    return;
                  }
                  if (item.views && !open) setOpen(item.id, true);
                  closeOnMobile();
                };
                const button = (
                  <SidebarMenuButton
                    aria-expanded={item.views && !rail ? open : undefined}
                    isActive={onPage && (rail || !view)}
                    onClick={onRowClick}
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
                    <SidebarMenuChevron open={open} />
                    <CollapsiblePanel className="group-data-[collapsible=icon]:hidden">
                      <SidebarMenuSub>
                        {item.views.map((sub) => (
                          <SidebarMenuSubItem key={sub.id}>
                            <SidebarMenuSubButton
                              isActive={view?.id === sub.id}
                              onClick={closeOnMobile}
                              render={<Link search={{ status: sub.status }} to={sub.to} />}
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
