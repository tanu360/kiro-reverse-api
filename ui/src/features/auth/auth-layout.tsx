import { PlugIcon, ShieldCheckIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { ThemeSwitch } from "@/components/layout/theme-switch";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useT } from "@/lib/i18n";

/** Full-page frame for the signed-out pages: top bar, one centered card, compat footer. */
export function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT("auth");
  const { t: tShared } = useT();

  return (
    <div className="relative isolate flex min-h-svh flex-col overflow-x-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:2.5rem_2.5rem] [mask-image:radial-gradient(ellipse_at_center,black_10%,transparent_70%)]"
      />
      <header className="flex h-14 items-center justify-between gap-2 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <img
            alt=""
            className="size-6 shrink-0 rounded-md dark:invert"
            height={24}
            src="/admin/icon.png"
            width={24}
          />
          <span className="truncate font-semibold text-base">{tShared("shell.appName")}</span>
        </div>
        <div className="flex items-center gap-1">
          <LanguageSwitch />
          <Separator className="mx-1 h-5" orientation="vertical" />
          <ThemeSwitch />
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-8" id="main">
        <Card className="w-full max-w-sm">{children}</Card>
        <p className="flex max-w-sm items-center gap-1.5 text-center text-muted-foreground text-xs">
          <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {t("secureHint")}
        </p>
      </main>
      <footer className="flex flex-col items-center gap-3 px-4 pb-6 text-center">
        <ul className="flex flex-wrap justify-center gap-2">
          {[t("compatOpenAI"), t("compatAnthropic")].map((label) => (
            <li key={label}>
              <Badge variant="outline">
                <PlugIcon aria-hidden="true" />
                {label}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="max-w-sm text-balance text-muted-foreground text-xs">{t("tagline")}</p>
      </footer>
    </div>
  );
}
