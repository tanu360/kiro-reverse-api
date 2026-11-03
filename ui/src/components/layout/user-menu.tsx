import { useNavigate } from "@tanstack/react-router";
import { EllipsisVerticalIcon, LogOutIcon, RefreshCwIcon, UserRoundIcon } from "lucide-react";
import { type JSX, useCallback } from "react";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { useUpdateCheck } from "./update-check";

/** DELETE /session (errors ignored), then the sign-in page. No confirm (old UI parity). */
export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await signOut();
    } catch {
      // The server session may already be gone; the local session is cleared either way.
    }
    await navigate({ to: "/login" });
  }, [navigate]);
}

function UserMenuItems(): JSX.Element {
  const { t } = useT();
  const { checking, checkNow } = useUpdateCheck();
  const handleSignOut = useSignOut();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>{t("shell.admin")}</MenuGroupLabel>
        <MenuItem disabled={checking} onClick={checkNow}>
          {checking ? <Spinner aria-hidden="true" /> : <RefreshCwIcon aria-hidden="true" />}
          {checking ? t("shell.update.checking") : t("shell.update.check")}
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onClick={() => void handleSignOut()}>
        <LogOutIcon aria-hidden="true" />
        {t("shell.signOut")}
      </MenuItem>
    </>
  );
}

function AdminAvatar(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted font-medium text-muted-foreground text-xs"
    >
      A
    </span>
  );
}

/**
 * The "Admin" user row in the sidebar footer, or an icon button in the header.
 * Both open the same menu: Check for updates and Sign out.
 */
export function UserMenu({ variant = "sidebar" }: { variant?: "sidebar" | "header" }): JSX.Element {
  const { t } = useT();

  if (variant === "header") {
    return (
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    aria-label={t("shell.userMenu")}
                    className="size-10 md:size-8"
                    size="icon"
                    variant="ghost"
                  />
                }
              />
            }
          >
            <UserRoundIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{t("shell.userMenu")}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" className="min-w-52">
          <UserMenuItems />
        </MenuPopup>
      </Menu>
    );
  }

  return <SidebarUserMenu />;
}

function SidebarUserMenu(): JSX.Element {
  const { t } = useT();
  const { isMobile } = useSidebar();
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
        <AdminAvatar />
        <span className="grid flex-1 text-left text-sm leading-tight">
          <span className="truncate font-medium text-sidebar-foreground">{t("shell.admin")}</span>
          <span className="truncate text-secondary-label text-xs">{t("shell.appName")}</span>
        </span>
        <EllipsisVerticalIcon aria-hidden="true" className="ms-auto size-4" />
      </MenuTrigger>
      <MenuPopup
        align="end"
        className="min-w-56"
        side={isMobile ? "bottom" : "right"}
        sideOffset={4}
      >
        <UserMenuItems />
      </MenuPopup>
    </Menu>
  );
}
