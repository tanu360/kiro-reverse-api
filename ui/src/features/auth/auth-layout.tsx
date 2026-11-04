import type { JSX, ReactNode } from "react";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { ThemeSwitch } from "@/components/layout/theme-switch";
import { AppIcon } from "@/components/shared/app-icon";
import { useT } from "@/lib/i18n";
import { AuthShowcase } from "./auth-showcase";

/**
 * Full-page frame for the signed-out pages: the form column on the left (the page settings at
 * the top, the centred page block, the footer) and, from `lg` up, the purple showcase panel on
 * the right. The column is flat: borders and colour only, no shadows. The app icon sits over the
 * heading.
 */
export function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    // The panel keeps a wider margin above and below than at its side. The sign-in pages keep
    // lucide's 2 px icon stroke; the app shell uses t3code's lighter 1.75 (index.css).
    <div className="flex min-h-svh bg-background surface-grain text-foreground lg:gap-3 lg:px-3 lg:py-6 [&_svg.lucide[stroke-width='2']]:[stroke-width:2]">
      {/*
       * Three rows: the page settings, the page block, the footer. The outer rows split the
       * spare height equally, so the block sits at the true centre of the column whatever their
       * heights. When the page is taller than the screen the spare space goes first.
       */}
      <div className="grid min-w-0 flex-1 grid-rows-[1fr_auto_1fr]">
        {/*
         * Language and theme, two separate controls: language at the left (-ms-2 lines its flag
         * up with the column's edge), theme at the right.
         */}
        <div className="row-start-1 flex items-center justify-between gap-2 self-start px-6 pt-4 sm:px-10 lg:pt-0">
          <LanguageSwitch className="-ms-2" variant="flag" />
          <ThemeSwitch variant="segmented" />
        </div>
        <main className="row-start-2 px-6 py-12 sm:px-10" id="main">
          <div className="mx-auto flex w-full max-w-[22.5rem] flex-col gap-8">{children}</div>
        </main>
        <footer className="row-start-3 flex flex-col items-center gap-2 self-end px-6 pb-5 sm:px-10 lg:pb-0">
          <Copyright />
          <Disclaimer />
        </footer>
      </div>
      <AuthShowcase />
    </div>
  );
}

/**
 * "© 2026 · Kiro Proxy", centred, all in the muted text colour, with a middle dot before the
 * name. The locale's copyright line is split at the app name, so its own word order is
 * kept; the dot is decoration and hidden from screen readers.
 */
function Copyright(): JSX.Element {
  const { t } = useT();
  const line = t("shell.copyright", { year: new Date().getFullYear() });
  const name = t("shell.appName");
  const at = line.lastIndexOf(name);
  return (
    <p className="text-center text-[13px] text-muted-foreground tabular-nums">
      {at < 0 ? (
        line
      ) : (
        <>
          {line.slice(0, at).trimEnd()}
          <span aria-hidden="true" className="mx-1.5">
            ·
          </span>
          <span>{name}</span>
          {line.slice(at + name.length)}
        </>
      )}
    </p>
  );
}

/** Under the copyright: this is an independent project (README wording). Text only. */
function Disclaimer(): JSX.Element {
  const { t } = useT("auth");
  return (
    <p className="text-balance text-center text-muted-foreground text-xs">{t("disclaimer")}</p>
  );
}

/**
 * The top of a signed-out page, centred as one block: the app icon, one h1 and a line of help
 * under it.
 */
export function AuthHeader({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center text-center">
      <AppIcon className="mb-6 size-16 shrink-0" size={64} />
      <h1 className="text-balance font-heading font-semibold text-2xl leading-tight sm:text-[1.75rem]">
        {title}
      </h1>
      <p className="mt-2.5 text-balance text-muted-foreground text-sm leading-relaxed">
        {description}
      </p>
    </div>
  );
}
