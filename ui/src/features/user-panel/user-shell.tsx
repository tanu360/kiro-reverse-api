import { LogOutIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type { JSX, ReactNode } from "react";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { ThemeSwitch } from "@/components/layout/theme-switch";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { AppIcon } from "@/components/shared/app-icon";
import { Button } from "@/components/ui/button";
import { CompactOnPhone } from "@/components/ui/compact-actions";
import { Separator } from "@/components/ui/separator";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The admin shell's scroll edges (app-shell.tsx): the page fades into the canvas under the
// sticky header and at the window's bottom edge, each fade as tall as main's padding.
const PAGE_FADE_CLASS = "pointer-events-none sticky z-15 h-4 shrink-0 from-background md:h-6";

/**
 * The key holder's frame: the admin header bar without the sidebar (sticky, 48 px, a hairline
 * under it) holding the brand as the sidebar header shows it, the language and theme menus and
 * Sign out, over the admin page column (`max-w-screen-2xl`, the `p-4 md:p-6` gutter, cards
 * 16 / 24 px apart).
 */
export function UserShell({
  children,
  onSignOut,
  signingOut = false,
}: {
  children: ReactNode;
  onSignOut: () => void;
  signingOut?: boolean;
}): JSX.Element {
  const { t } = useT();
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <a
        className="sr-only z-50 rounded-lg bg-background font-medium text-sm shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-3 focus:py-2 focus-outline"
        href="#main"
      >
        {t("shell.skipToContent")}
      </a>
      <header
        className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b bg-background"
        data-slot="site-header"
      >
        {/* The row shares the page's column, so the brand lines up with the page title. */}
        <div className="mx-auto flex w-full min-w-0 max-w-screen-2xl items-center justify-between gap-2 px-4 md:px-6">
          <Link
            className="flex min-w-0 items-center gap-2 rounded-md text-foreground focus-outline"
            to="/user"
          >
            <AppIcon className="size-5 max-w-none shrink-0 rounded-sm" size={20} />
            <span className="truncate font-semibold text-base">{t("shell.appName")}</span>
          </Link>
          {/*
            The last button's icon (a phone) or label sits on the page's right edge, as the admin
            header's glyph: pulled by its icon inset (8 px) or end padding (12 px). Default size,
            as tall as the icon buttons.
          */}
          <div className="-me-2 flex shrink-0 items-center gap-0.5 sm:-me-3 sm:gap-1">
            <LanguageSwitch />
            <ThemeSwitch variant="menu" />
            <Separator className="mx-1 h-4 self-center" orientation="vertical" />
            {/* On a phone an icon button, as the switches beside it. */}
            <CompactOnPhone>
              <Button loading={signingOut} onClick={onSignOut} variant="ghost">
                <AnimatedIcon icon={LogOutIcon} aria-hidden="true" />
                {t("shell.signOut")}
              </Button>
            </CompactOnPhone>
          </div>
        </div>
      </header>
      <div
        aria-hidden="true"
        className={cn(PAGE_FADE_CLASS, "top-12 -mb-4 bg-linear-to-b md:-mb-6")}
      />
      <main
        className="mx-auto flex w-full min-w-0 max-w-screen-2xl flex-1 flex-col gap-4 overflow-x-clip p-4 outline-none md:gap-6 md:p-6"
        id="main"
        tabIndex={-1}
      >
        {children}
      </main>
      <div
        aria-hidden="true"
        className={cn(PAGE_FADE_CLASS, "bottom-0 -mt-4 bg-linear-to-t md:-mt-6")}
      />
    </div>
  );
}
