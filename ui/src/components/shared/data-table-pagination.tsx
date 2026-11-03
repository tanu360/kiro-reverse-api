import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type JSX, useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";

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
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
}): JSX.Element {
  const { t, lang } = useT();
  const sizeLabelId = useId();
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  const showSizes = Boolean(pageSizeOptions?.length && onPageSizeChange);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
      <p aria-live="polite" className="text-muted-foreground tabular-nums">
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
        <Button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          size="sm"
          variant="outline"
        >
          <ChevronLeftIcon aria-hidden="true" />
          {t("table.previous")}
        </Button>
        <Button
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          size="sm"
          variant="outline"
        >
          {t("table.next")}
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
