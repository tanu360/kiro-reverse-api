import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Title block and actions share a row while both fit; otherwise the actions wrap below. The
 * decision follows the space the header actually has (a 20rem title basis plus the actions'
 * own width), not the viewport, so a persistent sidebar or a narrow window never squeezes the
 * title or description under the buttons.
 *
 * The app's type scale starts here, after the sign-in pages: a calm semibold title (20 px on
 * phones, 22 px from sm up) over a 14 px muted description. Cards step down to a 15 px title
 * (SectionCard), tables to 13 px headers over 14 px cells, and meta lines to 12-13 px.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 grow basis-80 flex-col gap-1.5">
        {/* With actions, the title row is the buttons' height, so the two share a centre line. */}
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1",
            actions ? "min-h-8" : undefined,
          )}
        >
          <h1 className="text-balance font-heading font-semibold text-xl leading-tight sm:text-[1.375rem]">
            {title}
          </h1>
          {meta}
        </div>
        {description ? (
          <p className="text-pretty text-muted-foreground text-sm leading-relaxed">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div
          className="flex max-w-full flex-wrap items-center gap-2"
          data-slot="page-header-actions"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
