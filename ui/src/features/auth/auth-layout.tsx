import { ShieldCheckIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { ThemeSwitch } from "@/components/layout/theme-switch";
import { useT } from "@/lib/i18n";
import { AuthShowcase } from "./auth-showcase";

/**
 * Full-page frame for the signed-out pages: the form column on the left (brand bar, form,
 * footer) and, from `lg` up, the purple showcase panel on the right.
 */
export function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT("auth");
  const { t: tShared } = useT();

  return (
    <div className="flex min-h-svh bg-background surface-grain text-foreground lg:gap-3 lg:p-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between gap-2 px-6 sm:px-10 lg:h-20">
          <div className="flex min-w-0 items-center gap-2.5">
            <img alt="" className="size-8 shrink-0" height={32} src="/admin/icon.webp" width={32} />
            <span className="truncate font-semibold text-lg tracking-tight">
              {tShared("shell.appName")}
            </span>
          </div>
          {/* One segmented control: the language (globe and short tag) and the theme toggle. */}
          <div className="flex items-center gap-0.5 rounded-full border bg-card/80 p-0.5 shadow-xs dark:bg-card">
            <LanguageSwitch className="rounded-full" variant="pill" />
            <span aria-hidden="true" className="h-4 w-px bg-border" />
            <ThemeSwitch className="rounded-full" />
          </div>
        </header>
        <main className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-10" id="main">
          <div className="mx-auto flex w-full max-w-sm flex-col gap-8">{children}</div>
        </main>
        <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 pb-6 text-muted-foreground text-xs sm:px-10 lg:pb-8">
          {/* Quieter than the hint beside it: smaller, and dimmer in dark (neutral-500, 4.6:1). */}
          <p className="font-normal text-[0.6875rem] tabular-nums dark:text-neutral-500">
            {tShared("shell.copyright", { year: new Date().getFullYear() })}
          </p>
          <p className="flex items-center gap-1.5">
            <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
            {t("secureHint")}
          </p>
        </footer>
      </div>
      <AuthShowcase />
    </div>
  );
}

/** The page heading of a signed-out page: one h1 and a line of help under it. */
export function AuthHeader({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-balance font-heading font-semibold text-3xl tracking-tight">{title}</h1>
      <p className="text-pretty text-muted-foreground text-sm leading-relaxed">{description}</p>
    </div>
  );
}
