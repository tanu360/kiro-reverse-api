import type { JSX, ReactNode } from "react";
import { Card, CardDescription, CardFooter, CardPanel } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
        className="flex flex-col gap-3 p-4 pb-3 sm:p-5 sm:pb-3 @md:flex-row @md:items-start @md:justify-between"
        data-slot="card-header"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h2
            className="font-heading font-medium text-base leading-snug"
            data-slot="card-title"
            id={headingId}
          >
            {title}
          </h2>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <CardPanel className="min-w-0 p-4 sm:p-5">{children}</CardPanel>
      {footer ? <CardFooter className="border-t p-4 sm:p-5">{footer}</CardFooter> : null}
    </Card>
  );
}
