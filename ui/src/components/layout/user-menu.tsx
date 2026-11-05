import {
  CircleArrowUp02Icon,
  EllipsisVerticalIcon,
  LogOutIcon,
  RefreshCwIcon,
  UserShield01Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useCallback, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { GithubLogo } from "@/components/shared/brand-logos";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { versionQuery } from "@/lib/api/system";
import { signOut } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";

export const GITHUB_URL = "https://github.com/tanu360/kiro-reverse-api";

/** DELETE /session (errors ignored), then the sign-in page. No confirm (old UI parity). */
export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await signOut();
    } catch {
      // The server session may already be gone; the local session is cleared either way.
    }
    // Toasts from the session (for example "Change the generated password" with its link to
    // Settings) must not follow the user onto the sign-in page.
    toast.dismiss();
    await navigate({ to: "/login" });
  }, [navigate]);
}

/** `onCheckSettled` closes the menu once a manual check has its answer. */
function UserMenuItems({ onCheckSettled }: { onCheckSettled: () => void }): JSX.Element {
  const { t } = useT();
  const { checking, checkNow, latest, openDialog } = useUpdateCheck();
  const handleSignOut = useSignOut();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>{t("shell.admin")}</MenuGroupLabel>
        {latest ? (
          <MenuItem onClick={openDialog}>
            <AnimatedIcon
              icon={CircleArrowUp02Icon}
              aria-hidden="true"
              className="text-warning-foreground"
            />
            {t("shell.update.available", { latest: stripV(latest.version) })}
          </MenuItem>
        ) : (
          // Stays open while it checks: the spinner takes the icon's place, the label stays and
          // aria-busy marks the row (a second click does nothing). The menu closes when the
          // answer is in, just before its toast or the update dialog shows.
          <MenuItem
            aria-busy={checking || undefined}
            closeOnClick={false}
            onClick={() => checkNow(onCheckSettled)}
          >
            {checking ? (
              <Spinner aria-hidden="true" />
            ) : (
              <AnimatedIcon icon={RefreshCwIcon} aria-hidden="true" />
            )}
            {t("shell.update.check")}
          </MenuItem>
        )}
        <MenuItem render={<a href={GITHUB_URL} rel="noopener" target="_blank" />}>
          <GithubLogo className="size-4" />
          {t("shell.github")}
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onClick={() => void handleSignOut()}>
        <AnimatedIcon icon={LogOutIcon} aria-hidden="true" />
        {t("shell.signOut")}
      </MenuItem>
    </>
  );
}

/**
 * The "Admin" user row in the sidebar footer, the version number under the name: Check for
 * updates, GitHub and Sign out. The header has no copy of it; the sidebar row is the one way in.
 */
export function UserMenu(): JSX.Element {
  return <SidebarUserMenu />;
}

function SidebarUserMenu(): JSX.Element {
  const { t } = useT();
  const { isMobile } = useSidebar();
  const { data } = useQuery(versionQuery());
  // The bare number (2.1.0), no leading v.
  const version = data?.version ? stripV(data.version) : null;
  const { checking } = useUpdateCheck();
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* The check's row keeps its label while busy; this tells screen readers it is checking. */}
      <span className="sr-only" role="status">
        {checking ? t("shell.update.checking") : ""}
      </span>
      <Menu onOpenChange={setOpen} open={open}>
        <MenuTrigger
          render={
            <SidebarMenuButton
              aria-label={t("shell.userMenu")}
              className="data-popup-open:bg-sidebar-row-active data-popup-open:text-sidebar-foreground"
              size="lg"
              tooltip={version ? `${t("shell.admin")} · ${version}` : t("shell.admin")}
            />
          }
        >
          {/*
           * The admin's mark in a chip, as tall as the two lines beside it, like a workspace avatar;
           * in the icon rail the chip is the whole button.
           */}
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
            <AnimatedIcon icon={UserShield01Icon} aria-hidden="true" className="size-4" />
          </span>
          <span className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium text-sidebar-foreground">{t("shell.admin")}</span>
            {version ? (
              <span className="truncate text-sidebar-muted-foreground text-xs">{version}</span>
            ) : null}
          </span>
          <AnimatedIcon icon={EllipsisVerticalIcon} aria-hidden="true" className="ms-auto size-4" />
        </MenuTrigger>
        {/* From the sidebar (desktop) 12 px out, so the popup clears the sidebar's edge line. */}
        <MenuPopup align="end" side={isMobile ? "bottom" : "right"} sideOffset={isMobile ? 4 : 12}>
          <UserMenuItems onCheckSettled={() => setOpen(false)} />
        </MenuPopup>
      </Menu>
    </>
  );
}
