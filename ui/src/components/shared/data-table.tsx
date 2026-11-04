import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { type JSX, type KeyboardEvent, type MouseEvent, type ReactNode, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-media-query";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Own column type, so features do not depend on the TanStack Table major version. */
export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  align?: "start" | "end" | "center";
  width?: string;
  className?: string;
  headerClassName?: string;
  /**
   * Pins the column while the table scrolls sideways. `true` or "start" pins it to the left
   * edge (a row label such as Time); "end" pins it to the right edge (row actions), so they stay
   * reachable when a narrow container hides the middle columns.
   */
  sticky?: boolean | "start" | "end";
}

export interface DataTableSort {
  id: string;
  desc: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  getRowId: (row: T, index: number) => string;
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort) => void;
  defaultSortDesc?: (columnId: string) => boolean;
  selection?: {
    selected: ReadonlySet<string>;
    onChange: (next: Set<string>) => void;
    rowLabel: (row: T) => string;
  };
  onRowClick?: (row: T) => void;
  renderMobileCard?: (row: T, ctx: { selected: boolean; toggleSelected: () => void }) => ReactNode;
  loading?: boolean;
  emptyState?: ReactNode;
  caption?: string;
  className?: string;
  /**
   * The table runs edge to edge in a SectionCard: it cancels the card's side padding and pads
   * its first and last columns by the same amount, so the row hairlines reach the card's border
   * and the first column lines up with the card title.
   */
  bleed?: boolean;
}

const BLEED_WRAPPER = "-mx-4 sm:-mx-5";
const BLEED_TABLE =
  "[&_tr>*:first-child]:ps-4 [&_tr>*:last-child]:pe-4 sm:[&_tr>*:first-child]:ps-5 sm:[&_tr>*:last-child]:pe-5";

// Row-level click and key handlers ignore events that start inside these.
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [role="switch"], [role="tab"], [contenteditable="true"], [data-row-interactive]';

function fromInteractiveChild(event: { target: EventTarget; currentTarget: EventTarget }): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || target === event.currentTarget) return false;
  const hit = target.closest(INTERACTIVE_SELECTOR);
  return hit !== null && (event.currentTarget as HTMLElement).contains(hit);
}

const ALIGN_CLASS = { start: "text-left", center: "text-center", end: "text-right" } as const;
// Column headers sit a step under the 14 px cells: 13 px, regular weight, muted (the sort
// button turns the sorted column's header to the text colour).
const HEAD_CLASS = "font-normal text-[13px]";
// Sticky cells need an opaque background: the panel's own (the card at 40 % over the page, as
// t3code's SettingsGroup), with the row's hover and selected tints (foreground at 2 and 4 %) on
// top, so a pinned cell does not read as a separate block.
const STICKY_BASE =
  "sticky z-[1] [--sticky-bg:color-mix(in_srgb,var(--card)_40%,var(--background))] bg-(--sticky-bg) [tr:hover>&]:bg-[color-mix(in_srgb,var(--sticky-bg),var(--foreground)_2%)] [tr[data-state=selected]>&]:bg-[color-mix(in_srgb,var(--sticky-bg),var(--foreground)_4%)]";
const STICKY_CLASS = {
  start: cn(STICKY_BASE, "left-0"),
  end: cn(
    STICKY_BASE,
    "right-0 shadow-[inset_1px_0_0_color-mix(in_srgb,var(--border)_50%,transparent)]",
  ),
} as const;
// Body rows are split by t3code's row divider (border at 50 %); the header keeps the full line.
const ROW_DIVIDERS = "[&_tbody>tr]:border-border/50";

function stickyClass(sticky: DataTableColumn<unknown>["sticky"]): string | undefined {
  if (!sticky) return undefined;
  return STICKY_CLASS[sticky === "end" ? "end" : "start"];
}
const coreFeatures = tableFeatures({});
const SKELETON_ROWS = 5;

interface Boxed<T> {
  value: T;
}

export function DataTable<T>({
  columns,
  data,
  getRowId,
  sort,
  onSortChange,
  defaultSortDesc,
  selection,
  onRowClick,
  renderMobileCard,
  loading = false,
  emptyState,
  caption,
  className,
  bleed = false,
}: DataTableProps<T>): JSX.Element {
  const { t } = useT();
  const isMobile = useIsMobile();

  // Rows are boxed because TanStack constrains row data to object shapes and T is open.
  const boxed = useMemo(() => data.map((value) => ({ value })), [data]);
  const tableColumns = useMemo<ColumnDef<typeof coreFeatures, Boxed<T>, unknown>[]>(
    () => columns.map((column) => ({ id: column.id })),
    [columns],
  );
  const table = useTable({
    features: coreFeatures,
    data: boxed,
    columns: tableColumns,
    getRowId: (row: Boxed<T>, index: number) => getRowId(row.value, index),
  });
  const rows = table.getRowModel().rows.map((row) => ({
    id: row.id,
    index: row.index,
    original: row.original.value,
  }));
  const rowIds = rows.map((row) => row.id);

  const selected = selection?.selected;
  const selectedCount = selected ? rowIds.filter((id) => selected.has(id)).length : 0;
  const allSelected = rowIds.length > 0 && selectedCount === rowIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const toggleAll = () => {
    if (!selection) return;
    // Clearing from the all-selected state drops the whole selection, including rows a
    // filter hides (old UI parity). Otherwise every visible row is added.
    if (allSelected) {
      selection.onChange(new Set());
      return;
    }
    const next = new Set(selection.selected);
    for (const id of rowIds) next.add(id);
    selection.onChange(next);
  };

  const toggleOne = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };

  const sortBy = (column: DataTableColumn<T>) => {
    if (!onSortChange) return;
    if (sort?.id === column.id) {
      onSortChange({ id: column.id, desc: !sort.desc });
      return;
    }
    onSortChange({ id: column.id, desc: defaultSortDesc?.(column.id) ?? false });
  };

  const onRowClickEvent = (row: T) => (event: MouseEvent<HTMLElement>) => {
    if (fromInteractiveChild(event)) return;
    onRowClick?.(row);
  };

  const onRowKeyDown = (row: T) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onRowClick?.(row);
  };

  const showEmpty = !loading && rows.length === 0;

  if (isMobile && renderMobileCard) {
    if (loading && rows.length === 0) {
      return (
        <div aria-busy="true" className={cn("flex flex-col gap-2", className)}>
          {Array.from({ length: 3 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cards never reorder.
            <Skeleton className="h-20 w-full rounded-xl border border-border/60" key={index} />
          ))}
        </div>
      );
    }
    if (showEmpty) return <div className={className}>{emptyState}</div>;
    return (
      <ul aria-label={caption} className={cn("flex flex-col gap-2", className)}>
        {rows.map((row) => {
          const isSelected = selected?.has(row.id) ?? false;
          return (
            <li data-state={isSelected ? "selected" : undefined} key={row.id}>
              {renderMobileCard(row.original, {
                selected: isSelected,
                toggleSelected: () => toggleOne(row.id),
              })}
            </li>
          );
        })}
      </ul>
    );
  }

  // The empty state sits under the table, outside its horizontal scroller, so it stays centred
  // in the visible width instead of across the full scroll width of a wide table.
  return (
    <div className={cn("min-w-0", bleed && BLEED_WRAPPER)} data-slot="data-table">
      <Table
        aria-busy={loading || undefined}
        className={cn(ROW_DIVIDERS, bleed && BLEED_TABLE, className)}
      >
        {caption ? <TableCaption className="sr-only">{caption}</TableCaption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selection ? (
              <TableHead className={cn(HEAD_CLASS, "w-px")}>
                <Checkbox
                  aria-label={t("table.selectAll")}
                  checked={allSelected}
                  disabled={rowIds.length === 0}
                  indeterminate={someSelected}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
            ) : null}
            {columns.map((column) => {
              const active = sort?.id === column.id;
              const ariaSort = column.sortable
                ? active
                  ? sort?.desc
                    ? "descending"
                    : "ascending"
                  : "none"
                : undefined;
              const SortIcon = active
                ? sort?.desc
                  ? ArrowDownIcon
                  : ArrowUpIcon
                : ArrowUpDownIcon;
              return (
                <TableHead
                  aria-sort={ariaSort}
                  className={cn(
                    HEAD_CLASS,
                    ALIGN_CLASS[column.align ?? "start"],
                    stickyClass(column.sticky),
                    column.headerClassName,
                  )}
                  key={column.id}
                  style={column.width ? { width: column.width } : undefined}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      // Fills the 40 px header height so the whole header cell is the target.
                      className={cn(
                        "-mx-1 inline-flex h-10 cursor-pointer items-center gap-1 rounded-md px-1 outline-none transition-colors hover:text-foreground focus-outline-inset",
                        active && "text-foreground",
                        column.align === "end" && "flex-row-reverse",
                      )}
                      onClick={() => sortBy(column)}
                      type="button"
                    >
                      {column.header}
                      <SortIcon
                        aria-hidden="true"
                        className={cn("size-3.5 shrink-0", !active && "opacity-50")}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && rows.length === 0
            ? Array.from({ length: SKELETON_ROWS }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows never reorder.
                <TableRow aria-hidden="true" className="hover:bg-transparent" key={index}>
                  {selection ? (
                    <TableCell className="w-px">
                      <Skeleton className="size-4" />
                    </TableCell>
                  ) : null}
                  {/* Column classes too, so a column hidden by a breakpoint stays hidden here. */}
                  {columns.map((column) => (
                    <TableCell className={column.className} key={column.id}>
                      <Skeleton className="h-4 w-full max-w-32" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : null}
          {rows.map((row) => {
            const isSelected = selected?.has(row.id) ?? false;
            return (
              <TableRow
                className={cn(
                  onRowClick &&
                    "cursor-pointer outline-none focus-visible:bg-accent/50 focus-outline-inset",
                )}
                data-state={isSelected ? "selected" : undefined}
                key={row.id}
                onClick={onRowClick ? onRowClickEvent(row.original) : undefined}
                onKeyDown={onRowClick ? onRowKeyDown(row.original) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
              >
                {selection ? (
                  <TableCell className="w-px">
                    <Checkbox
                      aria-label={t("table.selectRow", { label: selection.rowLabel(row.original) })}
                      checked={isSelected}
                      onCheckedChange={() => toggleOne(row.id)}
                    />
                  </TableCell>
                ) : null}
                {columns.map((column) => (
                  <TableCell
                    className={cn(
                      ALIGN_CLASS[column.align ?? "start"],
                      stickyClass(column.sticky),
                      column.className,
                    )}
                    key={column.id}
                  >
                    {column.cell(row.original, row.index)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {showEmpty ? <div data-slot="data-table-empty">{emptyState}</div> : null}
    </div>
  );
}
