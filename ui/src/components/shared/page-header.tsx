import type { JSX, ReactNode } from "react";

/**
 * Title block and actions share a row while both fit; otherwise the actions wrap below. The
 * decision follows the space the header actually has (a 20rem title basis plus the actions'
 * own width), not the viewport, so a persistent sidebar or a narrow window never squeezes the
 * title or description under the buttons.
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
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 grow basis-80 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="font-heading font-medium text-xl leading-tight tracking-tight">{title}</h1>
          {meta}
        </div>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
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
