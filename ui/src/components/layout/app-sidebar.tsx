import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { AppIcon } from "@/components/shared/app-icon";
import { KiroLogo } from "@/components/shared/brand-logos";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { NavFooter } from "./nav-footer";
import { NavMain } from "./nav-main";
import { SidebarStage } from "./sidebar-stage";

/**
 * Port of Studio Admin app-sidebar: logo header over the stage artwork, nav, and a footer without
 * the promo card.
 * `data-app-sidebar` scopes t3code's sidebar palette (see index.css) to this sidebar.
 */
export function AppSidebar(): JSX.Element {
  const { t } = useT();
  const { isMobile, setOpenMobile } = useSidebar();
  const appName = t("shell.appName");

  return (
    <Sidebar
      collapsible="icon"
      data-app-sidebar=""
      sheetDescription={t("shell.sheetDescription")}
      sheetTitle={t("shell.navigation")}
      variant="sidebar"
    >
      <SidebarStage />
      {/* The logo row never paints a row background over the stars: no hover or pressed fill. */}
      <SidebarHeader className="h-12 justify-center py-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="text-sidebar-foreground hover:bg-transparent active:bg-transparent"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
              render={<Link to="/" />}
              tooltip={appName}
            >
              {/* Expanded: the app icon beside the name. The icon rail shows the coloured Kiro tile. */}
              <AppIcon
                className="size-5 shrink-0 rounded-sm group-data-[collapsible=icon]:hidden"
                size={20}
              />
              <KiroLogo className="hidden size-5 shrink-0 group-data-[collapsible=icon]:block" />
              <span className="font-semibold text-base text-sidebar-foreground">{appName}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("shell.navigation")}>
          <NavMain />
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <NavFooter />
      </SidebarFooter>
    </Sidebar>
  );
}
