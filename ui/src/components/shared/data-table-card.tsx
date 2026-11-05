import type { JSX, ReactNode } from "react";
import { DataTableInsetContext } from "@/components/shared/data-table";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The card a list page's table lives in: an optional toolbar (search, tabs, filters) over a
 * hairline, the table edge to edge (its first and last cells take the card's side padding, so
 * they line up with the toolbar), and a footer under a hairline for the pagination.
 *
 *   <DataTableCard toolbar={<Toolbar />} footer={<DataTablePagination … />}>
 *     <DataTable … />
 *   </DataTableCard>
 */
export function DataTableCard({
  toolbar,
  footer,
  children,
  className,
}: {
  toolbar?: ReactNode;
  /** Usually DataTablePagination; leave it out when there is nothing to page through. */
  footer?: ReactNode;
  /** The DataTable (or an ErrorState in its place). */
  children: ReactNode;
  /** Layout classes only; `@container/<name>` for column queries. */
  className?: string;
}): JSX.Element {
  return (
    <Card className={cn("min-w-0 gap-0 overflow-hidden", className)}>
      {toolbar ? (
        <div
          className="flex min-w-0 flex-col gap-3 border-border-subtle border-b px-4 py-3 sm:px-5"
          data-slot="data-table-card-toolbar"
        >
          {toolbar}
        </div>
      ) : null}
      <div className="min-w-0" data-slot="data-table-card-body">
        <DataTableInsetContext.Provider value={true}>{children}</DataTableInsetContext.Provider>
      </div>
      {footer ? (
        <div
          className="border-border-subtle border-t px-4 py-2.5 sm:px-5"
          data-slot="data-table-card-footer"
        >
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
