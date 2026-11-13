import { Search01Icon, XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useRef, useState } from "react";
import { InfoHint } from "@/components/shared/info-hint";
import { PageSizeSelect, SortSelect, StatusTabs } from "@/components/shared/table-toolbar";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useElementWidth } from "@/hooks/use-element-width";
import type { RequestCounts } from "@/lib/api/requests";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { REQUEST_SORTS, type RequestSort } from "@/routes/-search";
import { defaultSortDesc, PAGE_SIZES } from "./request-model";

const SEARCH_DEBOUNCE_MS = 250;

/** Below this filter-row width (the @md container step, 28rem) the placeholder is the short one. */
const SHORT_PLACEHOLDER_BELOW = 448;

type StatusValue = "success" | "failed" | undefined;
type StatusTabValue = "all" | "success" | "failed";
const ALL = "all";

/** The column header each sort is named after. */
const SORT_LABEL_KEYS: Record<RequestSort, string> = {
  time: "time",
  status: "status",
  account: "account",
  api_key: "apiKey",
  model: "model",
  tokens: "tokens",
  credits: "credits",
  duration: "duration",
};

interface RequestsToolbarProps {
  /** The search in effect (the page holds it, never the URL). */
  search: string;
  status: StatusValue;
  /** Called with the trimmed text 250 ms after the viewer stops typing. */
  onSearchChange: (search: string) => void;
  onStatusChange: (status: StatusValue) => void;
  /** Requests per status in the whole log; undefined while they load or when they failed. */
  counts: RequestCounts | undefined;
  countsLoading: boolean;
  sort: RequestSort;
  desc: boolean;
  /** Mirrors a click on a column header. */
  onSortChange: (sort: RequestSort, desc: boolean) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  /** Requests the search matches in the current tab, for "34 of 11,412"; undefined until loaded. */
  shown: number | undefined;
  /** Clears the search and the status tab. */
  onClear: () => void;
}

/**
 * The Accounts toolbar's layout: status tabs (All, Succeeded, Failed, with counts), then a row
 * with the search (a row of its own below a 64rem card), "Sort by", Clear, the result count and
 * "Rows" at the end. It lives in DataTableCard's toolbar slot.
 */
export function RequestsToolbar({
  search,
  status,
  onSearchChange,
  onStatusChange,
  counts,
  countsLoading,
  sort,
  desc,
  onSortChange,
  pageSize,
  onPageSizeChange,
  shown,
  onClear,
}: RequestsToolbarProps): JSX.Element {
  const { t, lang } = useT("requests");
  const { t: tc } = useT();
  const [text, setText] = useState(search);
  const rowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const width = useElementWidth(rowRef);
  const latest = useRef({ search, onSearchChange });
  latest.current = { search, onSearchChange };

  // The page's search wins when it changes from elsewhere (Clear filters, a ?search= link).
  useEffect(() => {
    setText((current) => (current.trim() === search ? current : search));
  }, [search]);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === latest.current.search) return;
    const timer = setTimeout(() => latest.current.onSearchChange(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const all = counts ? counts.success + counts.failed : undefined;
  const tabs = [
    { value: ALL, label: t("allStatuses"), count: all },
    { value: "success", label: t("ok"), count: counts?.success },
    { value: "failed", label: t("fail"), count: counts?.failed },
  ] as const;
  const tabTotal = status ? counts?.[status] : all;
  const sortOptions = REQUEST_SORTS.map((column) => ({
    value: column,
    label: t(SORT_LABEL_KEYS[column]),
  }));
  // A status tab on its own is not a refinement: its badge already gives the count.
  const refined = Boolean(search);
  const placeholder =
    width > 0 && width < SHORT_PLACEHOLDER_BELOW
      ? t("searchPlaceholderShort")
      : t("searchPlaceholder");

  return (
    <div className="flex min-w-0 flex-col gap-3" data-slot="requests-toolbar">
      <StatusTabs<StatusTabValue>
        label={t("statusFilter")}
        loading={countsLoading}
        onValueChange={(next) => {
          const value = next === ALL ? undefined : next;
          if (value !== status) onStatusChange(value);
        }}
        tabs={tabs}
        value={status ?? ALL}
      />

      {/* Below a 64rem card the search has a row of its own and the controls follow under it. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2" ref={rowRef}>
        <InputGroup className="@5xl/requests:w-96">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("search")}
            autoComplete="off"
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && text) {
                event.preventDefault();
                setText("");
              }
            }}
            placeholder={placeholder}
            ref={inputRef}
            spellCheck={false}
            type="search"
            value={text}
          />
          {/*
            One trailing control at a time: the clear X takes the hint's slot while there is text,
            so it sits at the field's edge and the two touch targets never overlap.
          */}
          <InputGroupAddon align="inline-end">
            {text ? (
              <Button
                aria-label={t("clearSearch")}
                onClick={() => {
                  setText("");
                  inputRef.current?.focus();
                }}
                size="icon-xs"
                variant="quiet"
              >
                <HugeiconsIcon icon={XIcon} aria-hidden="true" />
              </Button>
            ) : (
              // Opens on hover, click and tap; the label is for screen readers only.
              <InfoHint className="gap-0" hint={t("searchHint")}>
                <span className="sr-only">{t("searchHintLabel")}</span>
              </InfoHint>
            )}
          </InputGroupAddon>
        </InputGroup>

        <SortSelect
          defaultSortDesc={defaultSortDesc}
          desc={desc}
          onChange={(next, nextDesc) => {
            if (next) onSortChange(next, nextDesc);
          }}
          options={sortOptions}
          sort={sort}
        />

        {refined ? (
          <Button
            aria-label={tc("actions.clearFilters")}
            onClick={onClear}
            size="sm"
            variant="ghost"
          >
            {t("filter.clear")}
          </Button>
        ) : null}

        {/* The result count and the page size share the row's end. */}
        <div className="ms-auto flex shrink-0 items-center gap-2">
          {refined && shown !== undefined && tabTotal !== undefined ? (
            <span
              aria-live="polite"
              className="whitespace-nowrap text-meta text-muted-foreground tabular-nums"
            >
              {t("filter.results", {
                shown: formatNumber(shown, lang),
                total: formatNumber(tabTotal, lang),
              })}
            </span>
          ) : null}
          <PageSizeSelect onChange={onPageSizeChange} options={PAGE_SIZES} value={pageSize} />
        </div>
      </div>
    </div>
  );
}
