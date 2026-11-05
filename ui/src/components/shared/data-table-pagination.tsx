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

/*
 * The prev/next chevrons: round, in the topbar search pill's surface (command-menu.tsx: the
 * --field tint and the --input hairline), so they read on the page in both themes. Disabled keeps
 * the circle and only dims the chevron.
 */
const CHEVRON =
  "size-9 rounded-full border-input bg-(--field) text-foreground [--control-radius:9999px] [:hover,[data-pressed]]:bg-(--field-hover) disabled:text-muted-foreground/50 disabled:opacity-100";

export function DataTablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
}: {
  variant?: "default" | "circle";
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
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
    <div className="flex flex-wrap items-center justify-between gap-3 text-meta">
      <p aria-live="polite" className="text-muted-foreground">
        {t("table.pageInfo", {
          start: formatNumber(start, lang),
          end: formatNumber(end, lang),
          total: formatNumber(total, lang),
        })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {showSizes ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground" id={sizeLabelId}>
              {t("table.rowsPerPage")}
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
              <SelectTrigger aria-labelledby={sizeLabelId} className="w-20 min-w-20" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
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
              <Button
                aria-label={t("table.previous")}
                className={CHEVRON}
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
                size="icon"
                variant="quiet"
              >
                <HugeiconsIcon icon={ChevronLeftIcon} aria-hidden="true" />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <ol className="flex items-center gap-0.5 p-1">
                {pages.map((n, index) => (
                  <PaginationItem className="flex items-center gap-0.5" key={n}>
                    {index > 0 && n - pages[index - 1] > 1 ? (
                      <PaginationEllipsis className="min-w-4 text-muted-foreground" />
                    ) : null}
                    <PaginationLink
                      isActive={n === page}
                      render={
                        <Button
                          aria-label={formatNumber(n, lang)}
                          onClick={() => onPageChange(n)}
                          size="icon"
                          variant="quiet"
                          className={
                            n === page
                              ? "size-8 font-semibold text-foreground [--control-radius:9999px]"
                              : "size-8 [--control-radius:9999px]"
                          }
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
              <Button
                aria-label={t("table.next")}
                className={CHEVRON}
                disabled={page >= pageCount}
                onClick={() => onPageChange(page + 1)}
                size="icon"
                variant="quiet"
              >
                <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
