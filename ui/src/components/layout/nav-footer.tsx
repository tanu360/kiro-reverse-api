import { ArrowRight02Icon, Notification01Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  type SelfUpdate,
  UpdateStatusButton,
  UpdateStatusIcon,
  updateButtonAction,
} from "./self-update";
import { UpdateDot, useUpdateCheck } from "./update-check";
import { parseChangelog, stripV } from "./update-dialog";
import { UserMenu } from "./user-menu";

/**
 * The card's eyebrow: "New version", or where the self-update stands, with its dot's tone. Not a
 * live region: the self-update reads its steps out itself (useSelfUpdateController), also while
 * the card is out of sight.
 */
function eyebrow(update: SelfUpdate | null, t: TFunction): { text: string; dot: string } {
  switch (update?.phase) {
    case "starting":
    case "downloading":
      return {
        text:
          update.status?.progress === undefined
            ? t("shell.update.downloading")
            : t("shell.update.statusDownloading", { percent: update.status.progress }),
        dot: "bg-primary",
      };
    case "ready":
      return { text: t("shell.update.readyTitle"), dot: "bg-success" };
    case "restarting":
      return { text: t("shell.update.restarting"), dot: "bg-primary" };
    case "error":
      return { text: t("shell.update.statusFailed"), dot: "bg-destructive" };
    default:
      return { text: t("shell.update.eyebrow"), dot: "bg-warning" };
  }
}

/**
 * The update notice while a newer release is known; nothing while up to date (the manual check
 * is in the Admin menu and the ⌘K palette). Expanded, and in the phone sheet, it is a card: the
 * version and the changelog's first line, and a link to the update dialog. A server that can
 * update itself also gets a round status button at the card's end: it downloads the release,
 * fills a ring while it does, then asks to restart on it, and the eyebrow says where it stands
 * (after a failure, the reason replaces the changelog line).
 * The icon rail has no room for the card: it shows that button's glyph (or, for a server that
 * updates by hand, the bell with the orange dot), which does the same. The header and the Admin
 * menu carry no copy.
 */
function UpdateNotice(): JSX.Element | null {
  const { t } = useT();
  const { latest, openDialog, selfUpdate } = useUpdateCheck();
  if (!latest) return null;
  const version = stripV(latest.version);
  const self = selfUpdate.available ? selfUpdate : null;
  const action = self ? updateButtonAction(self, t) : null;
  const label = action?.label ?? t("shell.update.available", { latest: version });
  const headline = latest.changelog ? parseChangelog(latest.changelog)[0]?.text : undefined;
  const status = eyebrow(self, t);
  const failure = self?.phase === "error" ? self.error : undefined;
  return (
    <>
      <Card
        className="group-data-[collapsible=icon]:hidden"
        data-slot="sidebar-update-card"
        size="sm"
      >
        <p className="flex items-center gap-1.5 font-medium text-meta text-muted-foreground tabular-nums">
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", status.dot)} />
          {status.text}
        </p>
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground text-sm">
            {t("shell.update.cardTitle", { latest: version })}
          </p>
          {/* After a failure, why it failed in place of the changelog line (Try again is the
              round button below). */}
          {failure ? (
            <p className="wrap-break-word text-destructive-foreground text-meta">{failure}</p>
          ) : (
            <p className="line-clamp-2 text-meta text-muted-foreground">
              {headline ?? t("shell.update.newVersionMessage")}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm">
            <Button onClick={() => openDialog()} variant="link-action">
              {t("shell.update.whatsNew")}
              <AnimatedIcon icon={ArrowRight02Icon} aria-hidden="true" />
            </Button>
          </p>
          {self ? <UpdateStatusButton className="-my-1 -me-1" update={self} /> : null}
        </div>
      </Card>
      <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenuItem>
          <SidebarMenuButton
            data-slot="sidebar-notifications"
            onClick={action?.run ?? (() => openDialog())}
            tooltip={label}
          >
            {/* The glyph and its dot share a box, so the dot sits on the bell's corner. */}
            <span className="relative flex shrink-0 text-(--sidebar-icon-color) in-[[data-slot=sidebar-menu-button]:hover]:text-sidebar-foreground">
              {self ? (
                <span className="-m-2 grid size-8 place-items-center">
                  <UpdateStatusIcon phase={self.phase} progress={self.status?.progress} />
                </span>
              ) : (
                <>
                  <AnimatedIcon icon={Notification01Icon} aria-hidden="true" className="size-4" />
                  <UpdateDot className="-top-0.5 -right-0.5" />
                </>
              )}
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
