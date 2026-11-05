import type { JSX } from "react";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { UserMenu } from "./user-menu";

/**
 * The sidebar footer: the Admin row alone. The version is its second line; GitHub, the update
 * check and Sign out are in its menu. A newer release is already marked in the header (the
 * update indicator) and named in that menu, so nothing here repeats it, and the app name is in
 * the sidebar header.
 */
export function NavFooter(): JSX.Element {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <UserMenu />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
