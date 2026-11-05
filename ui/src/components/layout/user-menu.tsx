import {
  CircleArrowUp02Icon,
  EllipsisVerticalIcon,
  LogOutIcon,
  RefreshCwIcon,
} from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useCallback } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
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
import { signOut } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { UpdateDot, useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";

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

function UserMenuItems(): JSX.Element {
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
          <MenuItem disabled={checking} onClick={checkNow}>
            {checking ? (
              <Spinner aria-hidden="true" />
            ) : (
              <AnimatedIcon icon={RefreshCwIcon} aria-hidden="true" />
            )}
            {checking ? t("shell.update.checking") : t("shell.update.check")}
          </MenuItem>
        )}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onClick={() => void handleSignOut()}>
        <AnimatedIcon icon={LogOutIcon} aria-hidden="true" />
        {t("shell.signOut")}
      </MenuItem>
    </>
  );
}

function AdminAvatar(): JSX.Element {
  const { t } = useT();
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted font-medium text-muted-foreground text-xs"
    >
      {t("shell.avatarInitial")}
    </span>
  );
}

/**
 * The "Admin" user row in the sidebar footer: Check for updates and Sign out. The header has no
 * copy of it; the sidebar row is the one way in.
 */
export function UserMenu(): JSX.Element {
  return <SidebarUserMenu />;
}

function SidebarUserMenu(): JSX.Element {
  const { t } = useT();
  const { isMobile } = useSidebar();
  const { latest } = useUpdateCheck();
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            aria-label={t("shell.userMenu")}
            className="data-popup-open:bg-sidebar-row-active data-popup-open:text-sidebar-foreground"
            size="lg"
            tooltip={t("shell.admin")}
          />
        }
      >
        <span className="relative shrink-0">
          <AdminAvatar />
          {latest ? <UpdateDot className="-top-0.5 -right-0.5 outline-sidebar" /> : null}
        </span>
        <span className="grid flex-1 text-left text-sm leading-tight">
          <span className="truncate font-medium text-sidebar-foreground">{t("shell.admin")}</span>
          <span className="truncate text-secondary-label text-xs">{t("shell.appName")}</span>
        </span>
        <AnimatedIcon icon={EllipsisVerticalIcon} aria-hidden="true" className="ms-auto size-4" />
      </MenuTrigger>
      <MenuPopup align="end" side={isMobile ? "bottom" : "right"} sideOffset={4}>
        <UserMenuItems />
      </MenuPopup>
    </Menu>
  );
}
