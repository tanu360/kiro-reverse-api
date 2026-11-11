import { ArrowRight02Icon, Notification01Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { UpdateDot, useUpdateCheck } from "./update-check";
import { parseChangelog, stripV } from "./update-dialog";
import { UserMenu } from "./user-menu";

/**
 * The update notice while a newer release is known; nothing while up to date (the manual check
 * is in the Admin menu and the ⌘K palette). Expanded, and in the phone sheet, it is a card: the
 * version and the changelog's first line, and a link to the update dialog. The icon rail has no
 * room for the card, so it shows the bell with the orange dot instead, which opens the same
 * dialog. The header and the Admin menu carry no copy.
 */
function UpdateNotice(): JSX.Element | null {
  const { t } = useT();
  const { latest, openDialog } = useUpdateCheck();
  if (!latest) return null;
  const version = stripV(latest.version);
  const label = t("shell.update.available", { latest: version });
  const headline = latest.changelog ? parseChangelog(latest.changelog)[0]?.text : undefined;
  return (
    <>
      <Card
        className="group-data-[collapsible=icon]:hidden"
        data-slot="sidebar-update-card"
        size="sm"
      >
        <p className="flex items-center gap-1.5 font-medium text-meta text-muted-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          {t("shell.update.eyebrow")}
        </p>
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground text-sm">
            {t("shell.update.cardTitle", { latest: version })}
          </p>
          <p className="line-clamp-2 text-meta text-muted-foreground">
            {headline ?? t("shell.update.newVersionMessage")}
          </p>
        </div>
        <p className="text-sm">
          <Button onClick={openDialog} variant="link-action">
            {t("shell.update.whatsNew")}
            <AnimatedIcon icon={ArrowRight02Icon} aria-hidden="true" />
          </Button>
        </p>
      </Card>
      <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenuItem>
          <SidebarMenuButton data-slot="sidebar-notifications" onClick={openDialog} tooltip={label}>
            {/* The glyph and its dot share a box, so the dot sits on the bell's corner. */}
            <span className="relative flex shrink-0 text-(--sidebar-icon-color) in-[[data-slot=sidebar-menu-button]:hover]:text-sidebar-foreground">
              <AnimatedIcon icon={Notification01Icon} aria-hidden="true" className="size-4" />
              <UpdateDot className="-top-0.5 -right-0.5" />
            </span>
            <span>{label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </>
  );
}

/**
 * The sidebar footer: the update card (only while a newer release is known) over the Admin row.
 * The version is the Admin row's second line; the update check, Help & docs, Report an issue,
 * GitHub and Sign out are in its menu. The app name is in the sidebar header.
 */
export function NavFooter(): JSX.Element {
  return (
    <>
      <UpdateNotice />
      <SidebarMenu>
        <SidebarMenuItem>
          <UserMenu />
        </SidebarMenuItem>
      </SidebarMenu>
    </>
  );
}
