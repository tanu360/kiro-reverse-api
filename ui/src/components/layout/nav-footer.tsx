import { Notification01Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { UpdateDot, useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";
import { UserMenu } from "./user-menu";

/**
 * The bell above the Admin row, shown only while a newer release is known: the one place the
 * notice stays once its toast is gone (the header and the Admin menu carry no copy). It carries
 * the orange dot and opens the update dialog. Up to date, there is no row; the manual check is
 * in the Admin menu and the ⌘K palette.
 */
function UpdateNotice(): JSX.Element | null {
  const { t } = useT();
  const { latest, openDialog } = useUpdateCheck();
  if (!latest) return null;
  const label = t("shell.update.available", { latest: stripV(latest.version) });
  return (
    <SidebarMenuItem>
      <SidebarMenuButton data-slot="sidebar-notifications" onClick={openDialog} tooltip={label}>
        {/* The glyph and its dot share a box, so the dot sits on the bell in the rail and the row. */}
        <span className="relative flex shrink-0 text-(--sidebar-icon-color) in-[[data-slot=sidebar-menu-button]:hover]:text-sidebar-foreground">
          <AnimatedIcon icon={Notification01Icon} aria-hidden="true" className="size-4" />
          <UpdateDot className="-top-0.5 -right-0.5" />
        </span>
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The sidebar footer: the update bell (only while a newer release is known) over the Admin row.
 * The version is the Admin row's second line; the update check, GitHub and Sign out are in its
 * menu. The app name is in the sidebar header.
 */
export function NavFooter(): JSX.Element {
  return (
    <SidebarMenu>
      <UpdateNotice />
      <SidebarMenuItem>
        <UserMenu />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
