import { ChevronLeftIcon, ChevronRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from "@/components/ui/pagination";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/*
 * The prev/next chevrons: round, in the topbar search pill's surface (command-menu.tsx: the
 * --field tint and the --input hairline), so they read on the page in both themes. Disabled keeps
 * the circle and only dims the chevron. The hover fill is hover-guarded (Tailwind's `hover:` only
 * applies on a hover-capable pointer), so a tapped chevron does not keep it on touch; pressed
 * shows it on every pointer.
 */
const PAGER_CHEVRON_CLASS =
  "rounded-full border-input bg-(--field) text-foreground before:rounded-full hover:bg-(--field-hover) data-pressed:bg-(--field-hover) disabled:text-muted-foreground/50 disabled:opacity-100";
/*
 * The page numbers and the ellipsis share one box, the icon button's (36 / 32 / coarse 40), so
 * the numbers keep an even beat; a wide number ("1,024") grows its box into a pill instead of
 * spilling out of the circle. The numbers are quiet buttons with no fill; the current page is the
 * bold one. Proportional digits: Geist's tabular 1 has a foot that reads as another typeface.
 */
const PAGE_BOX = "min-w-9 sm:min-w-8 pointer-coarse:min-w-10";
const PAGE = cn(PAGE_BOX, "rounded-full px-1.5 before:rounded-full");
const PAGE_ACTIVE = "font-semibold text-foreground";

/**
 * The pager's previous/next button, for any prev/next pair that should match the table
 * pager (a detail sheet stepping through rows). `label` is its accessible name.
 */
export function PagerChevronButton({
  direction,
  label,
  onClick,
  disabled = false,
  className,
}: {
  direction: "previous" | "next";
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  return (
    <Button
      aria-label={label}
      className={cn(PAGER_CHEVRON_CLASS, className)}
      disabled={disabled}
      onClick={onClick}
      size="icon"
      variant="quiet"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={direction === "previous" ? ChevronLeftIcon : ChevronRightIcon}
      />
    </Button>
  );
}

export function DataTablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** With `onPageSizeChange`, a "Rows" select for the page size (the app's only one). */
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
}): JSX.Element {
  const { t, lang } = useT();
  const sizeLabelId = useId();
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  const showSizes = Boolean(pageSizeOptions?.length && onPageSizeChange);

  const pages = [...new Set([1, page - 1, page, page + 1, pageCount])]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);

  return (
    // w-full: in a card footer (a flex row) the pager is the only child, so without it the root
    // shrinks to its content and the count and the pager sit together at the start.
    <div className="flex w-full flex-wrap items-center justify-between gap-3 text-meta">
      <p aria-live="polite" className="text-muted-foreground tabular-nums">
        {t("table.pageInfo", {
          start: formatNumber(start, lang),
          end: formatNumber(end, lang),
          total: formatNumber(total, lang),
        })}
      </p>
      {/*
        ms-auto keeps the pager on the right when it wraps under the count on a narrow screen.
        Rows and the pager stay on one line: below sm the page numbers collapse to "3 / 13"
        between the chevrons, so the footer is at most two rows on a phone.
      */}
      <div className="ms-auto flex items-center justify-end gap-2">
        {showSizes ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground" id={sizeLabelId}>
              {t("table.rowsShort")}
            </span>
            <Select
              items={(pageSizeOptions ?? []).map((size) => ({
                label: String(size),
                value: String(size),
              }))}
              onValueChange={(value) => {
                if (value) onPageSizeChange?.(Number(value));
              }}
              value={String(pageSize)}
            >
              {/*
                The default step (36 / 32 / coarse 40) matches the icon buttons beside it. The
                trigger is wider than index.css popup-width's icon cut-off (3rem), so the list
                fits its numbers instead of taking an icon menu's 11rem over the pager.
              */}
              <SelectTrigger aria-labelledby={sizeLabelId} fit="content" size="default">
                <SelectValue className="tabular-nums" />
              </SelectTrigger>
              <SelectPopup fit="content">
                {(pageSizeOptions ?? []).map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        <Pagination className="mx-0 w-auto max-w-full">
          <PaginationContent className="gap-2">
            <PaginationItem>
              <PagerChevronButton
                direction="previous"
                disabled={page <= 1}
                label={t("table.previous")}
                onClick={() => onPageChange(page - 1)}
              />
            </PaginationItem>
            <PaginationItem className="sm:hidden">
              <span className="block min-w-10 text-center text-foreground tabular-nums">
                {formatNumber(page, lang)} / {formatNumber(pageCount, lang)}
              </span>
            </PaginationItem>
            <PaginationItem className="max-sm:hidden">
              <ol className="flex items-center gap-0.5">
                {pages.map((n, index) => (
                  <PaginationItem className="flex items-center gap-0.5" key={n}>
                    {index > 0 && n - pages[index - 1] > 1 ? (
                      <PaginationEllipsis className={cn(PAGE_BOX, "text-muted-foreground")} />
                    ) : null}
                    <PaginationLink
                      isActive={n === page}
                      render={
                        <Button
                          aria-label={t("table.page", { n: formatNumber(n, lang) })}
                          className={cn(PAGE, n === page && PAGE_ACTIVE)}
                          onClick={() => onPageChange(n)}
                          variant="quiet"
                        />
                      }
                    >
                      {formatNumber(n, lang)}
                    </PaginationLink>
                  </PaginationItem>
                ))}
              </ol>
            </PaginationItem>
            <PaginationItem>
              <PagerChevronButton
                direction="next"
                disabled={page >= pageCount}
                label={t("table.next")}
                onClick={() => onPageChange(page + 1)}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
