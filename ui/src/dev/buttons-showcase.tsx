import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../index.css";
import {
  Download01Icon,
  PlusIcon,
  Refresh01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Dev-only showcase (vite dev: /admin/showcase-buttons.html; vite build bundles only index.html).
 * Every Button variant and size from button.tsx, their states, a smaller text-size proposal, and
 * six candidate looks for a secondary button. Light and dark side by side.
 */

type Size = NonNullable<ButtonProps["size"]>;
type Variant = NonNullable<ButtonProps["variant"]>;

const TEXT_SIZES: Size[] = ["xs", "sm", "default", "lg"];
const ICON_SIZES: Size[] = ["icon-xs", "icon-sm", "icon", "icon-lg"];
const VARIANTS: { v: Variant; note: string }[] = [
  { v: "default", note: "main action (purple)" },
  { v: "outline", note: "neutral: Refresh, Edit" },
  { v: "ghost", note: "Cancel, Back" },
  { v: "quiet", note: "header icons, kebab, Export" },
  { v: "secondary", note: "inverse fill" },
  { v: "danger", note: "in-row delete" },
  { v: "destructive", note: "confirm delete" },
  { v: "quiet-destructive", note: "row delete icon" },
  { v: "quiet-warning", note: "update notice" },
  { v: "lime", note: "sticker" },
  { v: "periwinkle", note: "sticker" },
  { v: "peach", note: "sticker" },
  { v: "link", note: "text link" },
];

const icon = <HugeiconsIcon aria-hidden="true" icon={PlusIcon} />;

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div>
        <h2 className="font-semibold text-sm">{title}</h2>
        {sub ? <p className="text-meta text-muted-foreground">{sub}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }): JSX.Element {
  return <span className="font-mono text-2xs text-muted-foreground">{children}</span>;
}

/*
 * Six secondary looks, written with theme tokens only. Each takes the Button's size and shape;
 * only the colour classes differ.
 */
const SECONDARY_STYLES: { name: string; from: string; className: string }[] = [
  {
    name: "1 · Soft fill",
    from: "coss ui / shadcn secondary (now the app's `secondary`)",
    className:
      "border-transparent bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--foreground)_12%,transparent)] data-pressed:bg-[color-mix(in_oklab,var(--foreground)_14%,transparent)]",
  },
  {
    name: "2 · Raised outline",
    from: "Vercel Geist secondary / shadcn outline",
    className:
      "border-border-strong/40 bg-background text-foreground shadow-xs hover:bg-accent data-pressed:bg-accent dark:bg-[color-mix(in_oklab,var(--color-white)_3%,var(--background))]",
  },
  {
    name: "3 · Brand soft",
    from: "Radix Themes soft",
    className:
      "border-transparent bg-primary/12 text-info-foreground hover:bg-primary/18 data-pressed:bg-primary/22",
  },
  {
    name: "4 · Brand surface",
    from: "Radix Themes surface",
    className:
      "border-primary/35 bg-primary/6 text-info-foreground hover:border-primary/55 hover:bg-primary/12 data-pressed:bg-primary/16",
  },
  {
    name: "5 · Glass",
    from: "Linear / Raycast",
    className:
      "border-[color-mix(in_oklab,var(--foreground)_10%,transparent)] bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)] text-foreground inset-shadow-[0_1px_--theme(--color-white/10%)] hover:bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] data-pressed:bg-[color-mix(in_oklab,var(--foreground)_11%,transparent)]",
  },
  {
    name: "6 · Inverse",
    from: "Vercel / Geist contrast (the old `secondary`)",
    className:
      "border-inverse bg-inverse text-inverse-foreground hover:bg-[color-mix(in_oklab,var(--inverse)_88%,var(--inverse-foreground))] data-pressed:bg-[color-mix(in_oklab,var(--inverse)_88%,var(--inverse-foreground))]",
  },
];

/* The text sizes before 2026-11-07 (coss ui scale), to compare with today's smaller ones. */
const BEFORE_TEXT: Partial<Record<Size, string>> = {
  xs: "text-sm sm:text-xs",
  sm: "text-sm sm:text-meta",
  default:
    "text-base sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  lg: "text-base sm:text-sm",
};

function Panel({ theme }: { theme: "light" | "dark" }): JSX.Element {
  return (
    <div
      className={cn(
        theme,
        "flex min-w-0 flex-1 flex-col gap-4 bg-background p-4 text-foreground sm:p-6",
      )}
    >
      <h1 className="font-semibold text-lg capitalize">{theme}</h1>

      <Section
        sub="Same label and icon at each size; phone (<640px) sizes show on a narrow screen"
        title="Variants × sizes"
      >
        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-x-3 border-spacing-y-2">
            <thead>
              <tr>
                <th className="text-left">
                  <Label>variant</Label>
                </th>
                {TEXT_SIZES.map((s) => (
                  <th className="text-left" key={s}>
                    <Label>{s}</Label>
                  </th>
                ))}
                {ICON_SIZES.map((s) => (
                  <th className="text-left" key={s}>
                    <Label>{s}</Label>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {VARIANTS.map(({ v, note }) => (
                <tr key={v}>
                  <td className="whitespace-nowrap pe-2 align-middle">
                    <div className="flex flex-col">
                      <span className="font-medium font-mono text-xs">{v}</span>
                      <Label>{note}</Label>
                    </div>
                  </td>
                  {TEXT_SIZES.map((s) => (
                    <td className="align-middle" key={s}>
                      <Button size={s} variant={v}>
                        {icon}
                        Button
                      </Button>
                    </td>
                  ))}
                  {ICON_SIZES.map((s) => (
                    <td className="align-middle" key={s}>
                      <Button aria-label="Add" size={s} variant={v}>
                        <HugeiconsIcon aria-hidden="true" icon={Settings02Icon} />
                      </Button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section sub="Rest · pressed (data-pressed) · disabled · loading" title="States">
        <div className="flex flex-col gap-2">
          {(["default", "outline", "ghost", "danger"] as Variant[]).map((v) => (
            <div className="flex flex-wrap items-center gap-2" key={v}>
              <span className="w-20 font-mono text-xs">{v}</span>
              <Button variant={v}>{icon}Save</Button>
              <Button data-pressed="" variant={v}>
                {icon}Save
              </Button>
              <Button disabled variant={v}>
                {icon}Save
              </Button>
              <Button loading variant={v}>
                {icon}Save
              </Button>
            </div>
          ))}
        </div>
      </Section>

      <Section
        sub="before: phone xs/sm/default/lg 14/14/16/16 px, desktop 12/13/14/14 px. now: phone 12/13/14/16 px, desktop 11/12/13/14 px."
        title="Text size: before vs now"
      >
        {(["before", "now"] as const).map((row) => (
          <div className="flex flex-wrap items-center gap-2" key={row}>
            <span className="w-20 font-mono text-xs">{row}</span>
            {TEXT_SIZES.map((s) => (
              <div className="flex flex-col items-start gap-1" key={s}>
                <Button
                  className={row === "before" ? BEFORE_TEXT[s] : undefined}
                  size={s}
                  variant="outline"
                >
                  <HugeiconsIcon aria-hidden="true" icon={Refresh01Icon} />
                  Refresh
                </Button>
                <Label>{s}</Label>
              </div>
            ))}
            <Button className={row === "before" ? BEFORE_TEXT.default : undefined}>
              {icon}
              Add account
            </Button>
          </div>
        ))}
      </Section>

      <Section
        sub="Same size and shape; only the colour treatment changes. Rest · pressed · disabled, and next to the purple primary."
        title="Secondary button: 6 candidates"
      >
        <div className="flex flex-col gap-3">
          {SECONDARY_STYLES.map((style) => (
            <div className="flex flex-col gap-1.5" key={style.name}>
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-sm">{style.name}</span>
                <Label>{style.from}</Label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button className={style.className} variant="outline">
                  <HugeiconsIcon aria-hidden="true" icon={Download01Icon} />
                  Export
                </Button>
                <Button className={style.className} data-pressed="" variant="outline">
                  <HugeiconsIcon aria-hidden="true" icon={Download01Icon} />
                  Export
                </Button>
                <Button className={style.className} disabled variant="outline">
                  Export
                </Button>
                <Button className={style.className} size="sm" variant="outline">
                  <HugeiconsIcon aria-hidden="true" icon={Refresh01Icon} />
                  Refresh
                </Button>
                <Button
                  aria-label="Settings"
                  className={style.className}
                  size="icon"
                  variant="outline"
                >
                  <HugeiconsIcon aria-hidden="true" icon={Settings02Icon} />
                </Button>
                <span className="mx-1 h-6 w-px bg-border" />
                <Button className={style.className} variant="outline">
                  Cancel
                </Button>
                <Button>{icon}Add account</Button>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/*
 * One theme per page (?theme=dark), set on <html> like the app does: tokens that are defined
 * with var() at :root only resolve for the theme when the class sits on the root element.
 */
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");

function Showcase(): JSX.Element {
  return (
    <div className="min-h-svh bg-background">
      <Panel theme={theme} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Showcase />);
