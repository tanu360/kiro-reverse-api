import {
  AlertCircleIcon,
  BookOpen01Icon,
  BubbleChatQuestionIcon,
  CheckIcon,
  EllipsisVerticalIcon,
  LogOutIcon,
  RefreshCwIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
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
import { statusQuery, versionQuery } from "@/lib/api/system";
import { signOut } from "@/lib/auth/session";
import { type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { type UpdateCheckResult, useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";

export const GITHUB_URL = "https://github.com/tanu360/kiro-reverse-api";

/** The Help items: the repository's README and its issue tracker, each in a new tab. */
const HELP_LINKS: { id: string; label: string; href: string; icon: IconSvgElement }[] = [
  { id: "docs", label: "shell.help.docs", href: `${GITHUB_URL}#readme`, icon: BookOpen01Icon },
  {
    id: "issue",
    label: "shell.help.issue",
    href: `${GITHUB_URL}/issues`,
    icon: BubbleChatQuestionIcon,
  },
];

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

/**
 * The row of a manual update check, in the Admin menu and the ⌘K palette: its icon and label,
 * then for a few seconds its answer in their place, a tick and "Kiro Proxy is up to date." or an
 * alert and "Could not check for updates." (a click checks again).
 */
export function updateCheckRow(
  result: UpdateCheckResult | null,
  t: TFunction,
): { icon: IconSvgElement; label: string; tone?: string } {
  if (result === "upToDate") {
    return { icon: CheckIcon, label: t("shell.update.upToDate"), tone: "text-success-foreground" };
  }
  if (result === "failed") {
    return {
      icon: AlertCircleIcon,
      label: t("shell.update.checkFailed"),
      tone: "text-destructive-foreground",
    };
  }
  return { icon: RefreshCwIcon, label: t("shell.update.check") };
}

/** `onNewerRelease` closes the menu when a manual check finds a release (its dialog opens). */
function UserMenuItems({ onNewerRelease }: { onNewerRelease: () => void }): JSX.Element {
  const { t } = useT();
  const { checking, checkNow, checkResult, latest } = useUpdateCheck();
  const check = updateCheckRow(checkResult, t);
  const handleSignOut = useSignOut();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>{t("shell.admin")}</MenuGroupLabel>
        {/*
         * Only while no newer release is known: once one is, the bell above the Admin row names
         * it, so the menu carries no copy. Stays open while it checks: the spinner takes the
         * icon's place, the label stays and aria-busy marks the row (a second click does
         * nothing). Then the row says the answer itself; a newer release closes the menu and
         * opens the update dialog.
         */}
        {latest ? null : (
          <MenuItem
            aria-busy={checking || undefined}
            closeOnClick={false}
            onClick={() => checkNow(onNewerRelease)}
          >
            {checking ? (
              <Spinner aria-hidden="true" />
            ) : (
              <AnimatedIcon
                icon={check.icon}
                aria-hidden="true"
                className={check.tone}
                playOnSwap={checkResult !== null}
              />
            )}
            {/* The answer wraps rather than slide: it is read once, often in another language. */}
            {checkResult ? <span className="min-w-0 py-1.5">{check.label}</span> : check.label}
          </MenuItem>
        )}
        {HELP_LINKS.map((link) => (
          <MenuItem key={link.id} render={<a href={link.href} rel="noopener" target="_blank" />}>
            <AnimatedIcon icon={link.icon} aria-hidden="true" />
            {t(link.label)}
          </MenuItem>
        ))}
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
 * updates (until a newer release is known), Help & docs, Report an issue, GitHub and Sign out.
 * The header has no copy of it; the sidebar row is the one way in.
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
  // The live dot: /status answers every 10 s while the tab is visible (the Overview's query, so
  // one poll serves both). Green while it answers, red once a poll fails, none before the first.
  const status = useQuery(statusQuery());
  const live = status.isError ? false : status.isSuccess ? true : null;
  const liveLabel = live === null ? null : t(live ? "shell.proxy.online" : "shell.proxy.offline");
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
              aria-label={
                liveLabel ? t("shell.userMenuStatus", { status: liveLabel }) : t("shell.userMenu")
              }
              className="data-popup-open:bg-sidebar-row-active data-popup-open:text-sidebar-foreground"
              size="lg"
              tooltip={[t("shell.admin"), version, liveLabel].filter(Boolean).join(" · ")}
            />
          }
        >
          {/*
           * A server with a live dot: the proxy's state at a glance, and unlike the Kiro ghost in
           * the header, not a second copy of the logo. Its 32 px box is as tall as the two lines
           * beside it; in the icon rail the box is the whole button.
           */}
          <span className="relative flex size-8 shrink-0 items-center justify-center text-sidebar-foreground">
            <HugeiconsIcon aria-hidden="true" className="size-5" icon={ServerStack01Icon} />
            {live === null ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute end-1 bottom-1 size-2.5 rounded-full ring-2 ring-sidebar",
                  live ? "bg-success" : "bg-destructive",
                )}
              />
            )}
          </span>
          <span className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium text-sidebar-foreground">{t("shell.admin")}</span>
            {version ? (
              <span className="truncate text-sidebar-muted-foreground text-xs">{version}</span>
            ) : null}
          </span>
          <AnimatedIcon icon={EllipsisVerticalIcon} aria-hidden="true" className="ms-auto size-4" />
        </MenuTrigger>
        {/*
         * From the sidebar (desktop) 12 px out, so the popup clears the sidebar's edge line. In the
         * sheet it opens over the row, edge to edge with it: on tablets the sheet meets the
         * viewport edge and the row sits 8 px in, so the default 16 px collision padding would
         * push the popup 8 px past the row's end, onto the sheet's border.
         */}
        <MenuPopup
          align="end"
          collisionPadding={isMobile ? 8 : undefined}
          side={isMobile ? "bottom" : "right"}
          sideOffset={isMobile ? 4 : 12}
        >
          <UserMenuItems onNewerRelease={() => setOpen(false)} />
        </MenuPopup>
      </Menu>
    </>
  );
}
