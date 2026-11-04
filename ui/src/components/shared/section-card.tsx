import type { JSX, ReactNode } from "react";
import { Card, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A titled card section. One spacing rhythm on every page: 16 px of padding on phones and 20 px
 * from sm up, 16 px from the title block to the content, and a slim footer (12 px top and
 * bottom) under t3code's row divider (border at 50 %). The surface is the Card's, t3code's
 * SettingsGroup. The panel and footer are plain slots rather than CardPanel and
 * CardFooter, whose own paddings change with the card's other children.
 */

export function SectionCard({
  id,
  title,
  description,
  actions,
  footer,
  children,
  className,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <Card
      aria-labelledby={headingId}
      className={cn("@container min-w-0", className)}
      id={id}
      render={<section />}
    >
      {/* Actions wrap below the title on narrow cards instead of clipping beside it. */}
      <div
        className="flex flex-col gap-3 p-4 sm:p-5 sm:pb-4 @md:flex-row @md:items-start @md:justify-between"
        data-slot="card-header"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h2
            className="font-heading font-semibold text-[0.9375rem] leading-snug"
            data-slot="card-title"
            id={headingId}
          >
            {title}
          </h2>
          {description ? (
            <CardDescription className="text-pretty leading-relaxed">{description}</CardDescription>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 px-4 pb-4 sm:px-5 sm:pb-5" data-slot="card-panel">
        {children}
      </div>
      {footer ? (
        <div
          className="flex items-center border-border/50 border-t px-4 py-3 sm:px-5"
          data-slot="card-footer"
        >
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
