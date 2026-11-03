import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
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

/** Port of Studio Admin app-sidebar: logo header, nav, and a footer without the promo card. */
export function AppSidebar(): JSX.Element {
  const { t } = useT();
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="h-12 justify-center py-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
              render={<Link to="/" />}
              tooltip={t("shell.appName")}
            >
              <img
                alt=""
                className="size-5 shrink-0 rounded-sm"
                height={20}
                src="/admin/icon.png"
                width={20}
              />
              <span className="font-semibold text-base">{t("shell.appName")}</span>
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
