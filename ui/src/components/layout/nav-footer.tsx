import { Notification01Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { UpdateDot, useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";
import { UserMenu } from "./user-menu";

/**
 * The bell above the Admin row: the app's one notice, a newer release, so the icon rail keeps it
 * in view as the header's update button does. With a release known it carries the orange dot and
 * opens the update dialog; otherwise it runs the same manual check as the Admin menu.
 */
function NotificationsButton(): JSX.Element {
  const { t } = useT();
  const { latest, checking, checkNow, openDialog } = useUpdateCheck();
  const label = latest
    ? t("shell.update.available", { latest: stripV(latest.version) })
    : t(checking ? "shell.update.checking" : "shell.update.check");
  return (
    <SidebarMenuButton
      aria-busy={checking || undefined}
      data-slot="sidebar-notifications"
      onClick={() => (latest ? openDialog() : checkNow())}
      tooltip={label}
    >
      {/* The glyph and its dot share a box, so the dot sits on the bell in the rail and the row. */}
      <span className="relative flex shrink-0 text-(--sidebar-icon-color) in-[[data-slot=sidebar-menu-button]:hover]:text-sidebar-foreground">
        <AnimatedIcon icon={Notification01Icon} aria-hidden="true" className="size-4" />
        {latest ? <UpdateDot className="-top-0.5 -right-0.5" /> : null}
      </span>
      <span>{label}</span>
    </SidebarMenuButton>
  );
}

/**
 * The sidebar footer: the notifications bell over the Admin row. The version is the Admin row's
 * second line; GitHub, the update check and Sign out are in its menu. The app name is in the
 * sidebar header.
 */
export function NavFooter(): JSX.Element {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <NotificationsButton />
      </SidebarMenuItem>
      <SidebarMenuItem>
        <UserMenu />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
