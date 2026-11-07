import { ArrowDown02Icon, ArrowUp02Icon, ArrowUpDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import {
  createContext,
  Fragment,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useId,
  useMemo,
} from "react";
import { CARD_GRID_CLASS, ListCardSkeleton } from "@/components/shared/list-card";
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
import { useT } from "@/lib/i18n";
import { cn, placeholderKeys } from "@/lib/utils";

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

export interface DataTableCardContext {
  selected: boolean;
  toggleSelected: () => void;
}

interface DataTableProps<T> {
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
  /**
   * The row (table row or card) under the pointer, or null when it leaves, to link a row to
   * something outside the table (a chart segment). Every row and card also carries
   * data-row-id and data-row-index.
   */
  onRowHover?: (row: T | null) => void;
  /**
   * The accessible name of a clickable row ("Open details for …"). With it the row also says it
   * opens a dialog (aria-haspopup).
   */
  rowLabel?: (row: T) => string;
  /**
   * Below this container width (DataTable's own, not the viewport) the rows render as cards
   * through `renderCard`: lg = 32rem, 2xl = 42rem, 3xl = 48rem, 4xl = 56rem, 5xl = 64rem (a table whose
   * first column needs about 250 px beside wide figure columns).
   */
  cardsBelow?: CardsBelow;
  renderCard?: (row: T, ctx: DataTableCardContext) => ReactNode;
  /**
   * One card's loading placeholder (a ListCardSkeleton with the real card's parts), repeated
   * for the rows a page holds. Without it divided rows show a generic ListCard row (title, meta
   * and two body lines) and stacked or gridded cards a plain block.
   */
  renderCardSkeleton?: () => ReactNode;
  /**
   * How the cards sit: a stack, a CardGrid (two columns from @2xl, equal heights), or rows
   * divided inside the surrounding card (ListCard variant="row").
   */
  cardLayout?: "stack" | "grid" | "divided";
  /** @deprecated Use `cardsBelow` + `renderCard`. Kept as `cardsBelow="lg"` until callers move. */
  renderMobileCard?: (row: T, ctx: DataTableCardContext) => ReactNode;
  loading?: boolean;
  /** Rows a full page holds; the loading placeholder shows as many (at most 10). */
  pageSize?: number;
  emptyState?: ReactNode;
  /**
   * A search or filter is active. An empty table then keeps its header, so the columns stay in
   * view while the filters change; without filters an empty table is only its empty state.
   */
  filtered?: boolean;
  caption?: string;
  className?: string;
  /**
   * The table runs edge to edge in a SectionCard: it cancels the card's side padding and pads
   * its first and last columns by the same amount, so the row hairlines reach the card's border
   * and the first column lines up with the card title.
   */
  bleed?: boolean;
  /**
   * The table already sits edge to edge (DataTableCard turns this on): the first and last cells
   * take the card's side padding, so cell text lines up with the card title.
   */
  inset?: boolean;
  /** Cell padding: compact 10 px (default), comfortable 12 px for two-line cells. */
  density?: "compact" | "comfortable";
}

type CardsBelow = "lg" | "2xl" | "3xl" | "4xl" | "5xl";

/** Set by DataTableCard: a DataTable inside it is inset without the prop. */
export const DataTableInsetContext = createContext(false);

const BLEED_WRAPPER = "-mx-4 sm:-mx-5";
const INSET_TABLE =
  "[&_tr>*:first-child]:ps-4 sm:[&_tr>*:first-child]:ps-5 [&_tr>*:last-child]:pe-4 sm:[&_tr>*:last-child]:pe-5";
const DENSITY_CLASS = { compact: undefined, comfortable: "[&_tbody_td]:py-3" } as const;

// Container-query switch between the cards and the table: both are rendered, CSS shows one.
// Static strings, so Tailwind sees every class.
const CARD_SWITCH: Record<CardsBelow, { cards: string; table: string }> = {
  lg: { cards: "@lg/data-table:hidden", table: "hidden @lg/data-table:block" },
  "2xl": { cards: "@2xl/data-table:hidden", table: "hidden @2xl/data-table:block" },
  "3xl": { cards: "@3xl/data-table:hidden", table: "hidden @3xl/data-table:block" },
  "4xl": { cards: "@4xl/data-table:hidden", table: "hidden @4xl/data-table:block" },
  "5xl": { cards: "@5xl/data-table:hidden", table: "hidden @5xl/data-table:block" },
};
const CARD_LIST_CLASS = {
  stack: "flex flex-col gap-2",
  grid: CARD_GRID_CLASS,
  divided: "flex flex-col divide-y divide-border-subtle",
} as const;
// Stacked or gridded cards need room around them inside an edge-to-edge table's card (the
// card's panel padding); divided rows carry their own.
const CARD_LIST_PAD = { inset: "px-4 py-4 sm:px-5", bleed: "px-4 sm:px-5" } as const;

// Row-level click and key handlers ignore events that start inside these.
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [role="switch"], [role="tab"], [contenteditable="true"], [data-row-interactive]';

function fromInteractiveChild(event: { target: EventTarget; currentTarget: EventTarget }): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || target === event.currentTarget) return false;
  const row = event.currentTarget as HTMLElement;
  // A row's menu or dialog renders in a portal, outside the row, but React still bubbles its
  // clicks to the row's handler. Those never count as a click on the row.
  if (!row.contains(target)) return true;
  const hit = target.closest(INTERACTIVE_SELECTOR);
  return hit !== null && row.contains(hit);
}

// Column headers come from TableHead: 13 px, regular weight, muted (the sort button turns the
// sorted column's header to the text colour). Right-aligned columns are figures.
const ALIGN_CLASS = {
  start: "text-left",
  center: "text-center",
  end: "text-right tabular-nums",
} as const;
// Sticky cells need an opaque background: the card the table sits in, with the row's own tint
// laid over it as an image (the header band, hover, keyboard focus, an open row menu, selected
// and selected-hovered). So a pinned cell matches its row exactly on any card fill. The body
// states exclude each other (selected, then an open menu, then hover or focus), so no selector
// order or specificity decides: an open menu keeps its tint under the pointer, as on the row
// (TableRow: an open [aria-haspopup=menu] trigger; a hover popover in a cell, such as the Limit
// reached hint, also sets aria-expanded and must not tint the row). A 1 px inset edge on the
// side facing the scrolling columns shows where they slide under it, only while something is
// hidden on that side (Table marks its scroller data-overflow-start/-end).
const STICKY_BASE =
  "sticky z-1 bg-card in-[thead]:bg-[linear-gradient(var(--row-head),var(--row-head))] [tbody>tr:is(:hover,:focus-visible):not([data-state=selected]):not(:has([aria-haspopup=menu][aria-expanded=true]))>&]:bg-[linear-gradient(var(--row-hover),var(--row-hover))] [tbody>tr:not([data-state=selected]):has([aria-haspopup=menu][aria-expanded=true])>&]:bg-[linear-gradient(color-mix(in_srgb,var(--row-selected)_50%,transparent),color-mix(in_srgb,var(--row-selected)_50%,transparent))] [tbody>tr[data-state=selected]>&]:bg-[linear-gradient(var(--row-selected),var(--row-selected))] [tbody>tr[data-state=selected]:hover>&]:bg-[linear-gradient(var(--row-selected-hover),var(--row-selected-hover))]";
const STICKY_CLASS = {
  start: cn(
    STICKY_BASE,
    "left-0 in-data-overflow-start:shadow-[inset_-1px_0_0_var(--border-subtle)]",
  ),
  end: cn(STICKY_BASE, "right-0 in-data-overflow-end:shadow-[inset_1px_0_0_var(--border-subtle)]"),
} as const;
// A clickable row's keyboard ring is drawn by an ::after layer above the sticky cells (z-[2]),
// so a pinned column cannot cover part of it.
const ROW_FOCUS =
  "cursor-pointer outline-none focus-visible:bg-(--row-hover) focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:z-2 focus-visible:after:outline focus-visible:after:outline-1 focus-visible:after:-outline-offset-1 focus-visible:after:outline-ring";

function stickyClass(sticky: DataTableColumn<unknown>["sticky"]): string | undefined {
  if (!sticky) return undefined;
  return STICKY_CLASS[sticky === "end" ? "end" : "start"];
}
const coreFeatures = tableFeatures({});
// One grid track per bar, up to the bar's width: the track's 0 floor adds nothing to the
// column's min-content (a fixed-width column keeps its width while loading), and its cap still
// asks an auto-width column for about its data width.
const SKELETON_LINE = {
  name: "grid w-full grid-cols-[minmax(0,--spacing(24))] items-center",
  meta: "grid w-full grid-cols-[minmax(0,--spacing(14))] items-center",
} as const;
const SKELETON_ALIGN = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
} as const;
const DEFAULT_SKELETON_ROWS = 5;
const MAX_SKELETON_ROWS = 10;
// Stacked or gridded cards are tall: three fill a phone screen.
const SKELETON_CARDS = 3;

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
  onRowHover,
  rowLabel,
  cardsBelow,
  renderCard,
  renderCardSkeleton,
  cardLayout = "stack",
  renderMobileCard,
  loading = false,
  pageSize,
  emptyState,
  filtered = false,
  caption,
  className,
  bleed = false,
  inset: insetProp,
  density = "compact",
}: DataTableProps<T>): JSX.Element {
  const { t } = useT();
  const selectAllId = useId();
  const insetFromCard = useContext(DataTableInsetContext);
  const inset = insetProp ?? insetFromCard;

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

  const hoverProps = (row: T) =>
    onRowHover
      ? { onPointerEnter: () => onRowHover(row), onPointerLeave: () => onRowHover(null) }
      : undefined;

  const onRowKeyDown = (row: T) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onRowClick?.(row);
  };

  const showEmpty = !loading && rows.length === 0;
  const showSkeleton = loading && rows.length === 0;
  const skeletonRows = Math.min(pageSize ?? DEFAULT_SKELETON_ROWS, MAX_SKELETON_ROWS);
  const wrapperClass = cn("@container/data-table min-w-0", bleed && BLEED_WRAPPER);

  // An empty table with nothing filtered is only its empty state: no header band over nothing.
  if (showEmpty && !filtered) {
    return (
      <div className={wrapperClass} data-slot="data-table">
        <div data-slot="data-table-empty">{emptyState}</div>
      </div>
    );
  }

  const cardRenderer = renderCard ?? renderMobileCard;
  const cardSwitch = cardRenderer
    ? CARD_SWITCH[cardsBelow ?? (renderCard ? "2xl" : "lg")]
    : undefined;
  const cardListClass = cn(
    CARD_LIST_CLASS[cardLayout],
    cardLayout !== "divided" && (bleed ? CARD_LIST_PAD.bleed : inset && CARD_LIST_PAD.inset),
  );

  const cards =
    cardRenderer && cardSwitch && !showEmpty ? (
      <div className={cardSwitch.cards} data-slot="data-table-cards">
        {showSkeleton ? (
          // Divided rows are as many as the table's placeholder rows (a page, at most 10), in
          // a ListCard row's geometry, so the list does not jump when the data arrives.
          <div aria-busy="true" className={cardListClass}>
            {placeholderKeys("card", cardLayout === "divided" ? skeletonRows : SKELETON_CARDS).map(
              (key) => (
                <Fragment key={key}>
                  {renderCardSkeleton ? (
                    renderCardSkeleton()
                  ) : cardLayout === "divided" ? (
                    <ListCardSkeleton lines={2} variant="row" />
                  ) : (
                    <Skeleton className="h-20 w-full rounded-xl" />
                  )}
                </Fragment>
              ),
            )}
          </div>
        ) : (
          <>
            {selection && rows.length > 0 ? (
              // The table header's select-all, for the cards (they have no header row): one
              // slim row over the list, its checkbox in line with the cards' own.
              <label
                className="flex cursor-pointer items-center gap-3 border-border-subtle border-b px-4 py-2.5 text-meta text-muted-foreground transition-colors hover:text-foreground sm:px-5"
                data-slot="data-table-select-all"
                htmlFor={selectAllId}
              >
                <Checkbox
                  aria-label={t("table.selectAll")}
                  checked={allSelected}
                  id={selectAllId}
                  indeterminate={someSelected}
                  onCheckedChange={toggleAll}
                />
                {t("table.selectAll")}
              </label>
            ) : null}
            <ul aria-label={caption} className={cardListClass}>
              {rows.map((row) => {
                const isSelected = selected?.has(row.id) ?? false;
                return (
                  <li
                    data-row-id={row.id}
                    data-row-index={row.index}
                    data-state={isSelected ? "selected" : undefined}
                    key={row.id}
                    {...hoverProps(row.original)}
                  >
                    {cardRenderer(row.original, {
                      selected: isSelected,
                      toggleSelected: () => toggleOne(row.id),
                    })}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    ) : null;

  // The empty state sits under the table, outside its horizontal scroller, so it stays centred
  // in the visible width instead of across the full scroll width of a wide table.
  return (
    <div className={wrapperClass} data-slot="data-table">
      {cards}
      <div className={cn("min-w-0", cardSwitch?.table)} data-slot="data-table-view">
        <Table
          aria-busy={loading || undefined}
          className={cn((inset || bleed) && INSET_TABLE, DENSITY_CLASS[density], className)}
        >
          {caption ? <TableCaption className="sr-only">{caption}</TableCaption> : null}
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {selection ? (
                <TableHead className="w-px">
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
                    ? ArrowDown02Icon
                    : ArrowUp02Icon
                  : ArrowUpDownIcon;
                return (
                  <TableHead
                    aria-sort={ariaSort}
                    className={cn(
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
                          "group/sort -mx-1 inline-flex h-10 cursor-pointer items-center gap-1 rounded-md px-1 outline-none transition-colors hover:text-foreground focus-outline-inset",
                          active && "text-foreground",
                          column.align === "end" && "flex-row-reverse",
                        )}
                        onClick={() => sortBy(column)}
                        type="button"
                      >
                        {column.header}
                        <HugeiconsIcon
                          icon={SortIcon}
                          aria-hidden="true"
                          // Only the sorted column shows its arrow; the others reveal theirs on hover or
                          // focus, in place (no shift), so the header row stays quiet.
                          className={cn(
                            "size-3.5 shrink-0 transition-opacity",
                            !active &&
                              "opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60",
                          )}
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
            {showSkeleton
              ? placeholderKeys("row", skeletonRows).map((key) => (
                  <TableRow aria-hidden="true" className="hover:bg-transparent" key={key}>
                    {selection ? (
                      // pe-0 as in the data rows (their checkbox cell drops its end padding),
                      // so the selection column is as wide while loading.
                      <TableCell className="w-px pe-0">
                        <Skeleton className="size-4" />
                      </TableCell>
                    ) : null}
                    {/* Column classes too, so a column hidden by a breakpoint stays hidden here. */}
                    {columns.map((column) => (
                      <TableCell className={column.className} key={column.id}>
                        {/*
                          Two bars on the two text lines of a real row (a 20 px name over a
                          14 px meta line: 34 px, the Accounts name cell), so the rows keep
                          their height when data arrives.
                          They sit on the column's side: a figure column's bars end at its
                          right-aligned header. Capped widths, not fractions of the cell: an
                          auto-width column then keeps about its data width while loading
                          instead of shrinking to its header beside a full-width name column.
                          In a fixed-width column narrower than the cap they shrink to fit, so
                          the column does not grow while loading (SKELETON_LINE).
                        */}
                        <div className="flex flex-col">
                          <span
                            className={cn(
                              SKELETON_LINE.name,
                              "h-5",
                              SKELETON_ALIGN[column.align ?? "start"],
                            )}
                          >
                            <Skeleton className="h-3.5" />
                          </span>
                          <span
                            className={cn(
                              SKELETON_LINE.meta,
                              "h-3.5",
                              SKELETON_ALIGN[column.align ?? "start"],
                            )}
                          >
                            <Skeleton className="h-3" />
                          </span>
                        </div>
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : null}
            {rows.map((row) => {
              const isSelected = selected?.has(row.id) ?? false;
              const label = onRowClick && rowLabel ? rowLabel(row.original) : undefined;
              return (
                <TableRow
                  aria-haspopup={label ? "dialog" : undefined}
                  aria-label={label}
                  className={cn(onRowClick && ROW_FOCUS)}
                  data-row-id={row.id}
                  data-row-index={row.index}
                  data-state={isSelected ? "selected" : undefined}
                  key={row.id}
                  onClick={onRowClick ? onRowClickEvent(row.original) : undefined}
                  onKeyDown={onRowClick ? onRowKeyDown(row.original) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  {...hoverProps(row.original)}
                >
                  {selection ? (
                    <TableCell className="w-px">
                      <Checkbox
                        aria-label={t("table.selectRow", {
                          label: selection.rowLabel(row.original),
                        })}
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
      </div>
      {showEmpty ? <div data-slot="data-table-empty">{emptyState}</div> : null}
    </div>
  );
}
