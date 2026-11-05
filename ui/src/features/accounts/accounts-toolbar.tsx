import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  ChevronDownIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { selectTriggerIconClassName, selectTriggerVariants } from "@/components/ui/select";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import type { Account } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  ACCOUNT_SORTS,
  type AccountSort,
  type AccountStatus,
  type AccountStatusFilter,
} from "@/routes/-search";
import {
  type AccountFilters,
  defaultSortDesc,
  FILTER_DIMENSIONS,
  type FilterDimension,
  type FilterOption,
  filterOptions,
  STATUS_GROUPS,
  type StatusGroup,
  statusFilterGroup,
  statusGroup,
} from "./account-model";

/** The dimensions with a "Label: Value" select; status has the tabs (and the Issue select). */
type FilterSelectDimension = Exclude<FilterDimension, "status">;
const SELECT_DIMENSIONS: readonly FilterSelectDimension[] = ["plan", "auth", "region", "enabled"];

/** The radio value of "All" in a select, and of the All tab. */
const ALL = "all";
/** The radio value of the sort select's "Default" (the server order). */
const DEFAULT_SORT = "default";

/**
 * A "Label: Value" trigger: the select trigger (components/ui/select.tsx SelectButton), the label
 * muted and the value in the text colour, or the accent once a filter is set. It opens a menu of
 * radio rows, so the trigger stays a button and the rows menu items.
 */
function FilterTrigger({
  label,
  value,
  active = false,
  after,
}: {
  label: string;
  value: string;
  active?: boolean;
  after?: ReactNode;
}): JSX.Element {
  // Two segments in one field, split by its hairline: the muted label, then the value and the
  // chevron. The segments are flex boxes, so the name is spelled out to read "Plan: All".
  return (
    <MenuTrigger
      aria-label={`${label}: ${value}`}
      className={cn(
        selectTriggerVariants(),
        "w-auto min-w-0 shrink-0 justify-start gap-0 overflow-hidden px-0",
      )}
    >
      <span className="flex items-center self-stretch border-field-border border-e px-2.5 text-muted-foreground">
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 ps-2.5 pe-2">
        <span className={cn("truncate", active && "text-info-foreground")}>{value}</span>
        {after}
        <HugeiconsIcon
          aria-hidden="true"
          className={cn(selectTriggerIconClassName, "text-muted-foreground")}
          icon={ChevronDownIcon}
        />
      </span>
    </MenuTrigger>
  );
}

/** One filter as "Label: Value ▾", with All and each value (and its count) in the menu. */
function FilterSelect({
  label,
  options,
  value,
  total,
  onValueChange,
}: {
  label: string;
  options: FilterOption[];
  /** The set value; undefined is All. */
  value: string | undefined;
  /** The count next to All. */
  total: number;
  onValueChange: (value: string | undefined) => void;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const current =
    value === undefined
      ? t("filter.all")
      : (options.find((option) => option.value === value)?.label ?? value);
  // Each row shows its count; a pick closes the menu, as in a select.
  return (
    <Menu>
      <FilterTrigger active={value !== undefined} label={label} value={current} />
      <MenuPopup align="start">
        <MenuRadioGroup
          onValueChange={(next) => onValueChange(next === ALL ? undefined : String(next))}
          value={value ?? ALL}
        >
          <MenuRadioItem closeOnClick meta={formatNumber(total, lang)} value={ALL}>
            {t("filter.all")}
          </MenuRadioItem>
          <MenuSeparator />
          {options.map((option) => (
            <MenuRadioItem
              closeOnClick
              key={option.value}
              meta={formatNumber(option.count, lang)}
              value={option.value}
            >
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** "Sort by: Usage ↓": the column the table headers sort by, and the direction. */
function SortSelect({
  sort,
  desc,
  onChange,
}: {
  sort: AccountSort | undefined;
  desc: boolean;
  onChange: (sort: AccountSort | undefined, desc: boolean) => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const DirectionIcon = desc ? ArrowDown02Icon : ArrowUp02Icon;
  return (
    <Menu>
      <FilterTrigger
        after={
          sort ? (
            <HugeiconsIcon
              icon={DirectionIcon}
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null
        }
        label={t("sort.by")}
        value={sort ? t(`columns.${sort}`) : t("sort.default")}
      />
      <MenuPopup align="start">
        <MenuRadioGroup
          onValueChange={(value) => {
            if (value === DEFAULT_SORT) {
              onChange(undefined, false);
              return;
            }
            const next = value as AccountSort;
            onChange(next, next === sort ? desc : defaultSortDesc(next));
          }}
          value={sort ?? DEFAULT_SORT}
        >
          <MenuRadioItem closeOnClick value={DEFAULT_SORT}>
            {t("sort.default")}
          </MenuRadioItem>
          {ACCOUNT_SORTS.map((column) => (
            <MenuRadioItem closeOnClick key={column} value={column}>
              {t(`columns.${column}`)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {sort ? (
          <>
            <MenuSeparator />
            <MenuRadioGroup
              onValueChange={(value) => onChange(sort, value === "desc")}
              value={desc ? "desc" : "asc"}
            >
              <MenuRadioItem closeOnClick value="asc">
                {t("sort.asc")}
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="desc">
                {t("sort.desc")}
              </MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** "Rows: 25": the page size, as a filter-style select at the end of the filter row. */
function PageSizeSelect({
  value,
  options,
  onChange,
}: {
  value: number;
  options: readonly number[];
  onChange: (size: number) => void;
}): JSX.Element {
  const { t, lang } = useT();
  return (
    <Menu>
      <FilterTrigger label={t("table.rowsShort")} value={formatNumber(value, lang)} />
      {/* Only short numbers: as wide as its trigger, not the 11rem a menu starts at. */}
      <MenuPopup align="end">
        <MenuRadioGroup onValueChange={(next) => onChange(Number(next))} value={String(value)}>
          {options.map((size) => (
            <MenuRadioItem closeOnClick key={size} value={String(size)}>
              {formatNumber(size, lang)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

type StatusTab = typeof ALL | StatusGroup;

/**
 * All, Active, Needs attention and Disabled, each with its count, over a hairline. `end` sits at
 * the right of the same row, on the same hairline (outside the tablist).
 */
function StatusTabs({
  value,
  counts,
  total,
  onValueChange,
  end,
}: {
  value: StatusTab;
  counts: Record<StatusGroup, number>;
  total: number;
  onValueChange: (value: StatusTab) => void;
  end?: ReactNode;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const label: Record<StatusTab, string> = {
    all: t("filter.all"),
    active: t("health.active"),
    attention: t("filter.attention"),
    disabled: t("health.disabled"),
  };
  const tabs: StatusTab[] = [ALL, ...STATUS_GROUPS];
  return (
    // The tabs and `end` stretch to one height, so their two hairlines meet in one line.
    <div className="-mb-px flex min-w-0 items-stretch">
      <Tabs
        className="min-w-0 flex-1"
        onValueChange={(next) => onValueChange(next as StatusTab)}
        value={value}
      >
        {/* Phones scroll the tabs sideways; the hairline spans the full row either way. */}
        <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsList
            aria-label={t("filter.status")}
            className="w-max min-w-full"
            variant="underline"
          >
            {tabs.map((tab) => (
              <TabsTab key={tab} value={tab}>
                {label[tab]}
                <Badge
                  className="min-w-5 tabular-nums"
                  size="sm"
                  tone={tab === value ? "primary" : "neutral"}
                >
                  {formatNumber(tab === ALL ? total : counts[tab], lang)}
                </Badge>
              </TabsTab>
            ))}
          </TabsList>
        </div>
      </Tabs>
      {end ? <div className="flex shrink-0 items-center border-b ps-2">{end}</div> : null}
    </div>
  );
}

export interface AccountsToolbarProps {
  /** The whole list: filter values and counts come from it, not from the filtered rows. */
  accounts: Account[];
  filters: AccountFilters;
  onFiltersChange: (patch: Partial<AccountFilters>) => void;
  onClearFilters: () => void;
  /** Rows after filtering, for the "12 of 48" count. */
  shown: number;
  /**
   * The list has not loaded yet: only the search shows, because zero counts and raw filter
   * values (a URL's `plan=pro`) would read as an empty fleet.
   */
  loading: boolean;
  sort: AccountSort | undefined;
  desc: boolean;
  /** Mirrors a click on a column header; undefined goes back to the server order. */
  onSortChange: (sort: AccountSort | undefined, desc: boolean) => void;
  /** The page size, picked at the end of the filter row (the pager below only pages). */
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (size: number) => void;
  /** List-wide actions (Export) at the right end of the status tab row. */
  tabActions?: ReactNode;
}

/**
 * Status tabs (All, Active, Needs attention, Disabled, with counts), then one row: search,
 * "Sort by", a "Label: Value" select per filter, Clear and the result count. A filter is offered
 * only when the list has two or more values of it (or a filter on it is set). Needs attention
 * groups the problem statuses; once it is picked, an Issue select narrows it to one of them.
 */
export function AccountsToolbar({
  accounts,
  filters,
  onFiltersChange,
  onClearFilters,
  shown,
  loading,
  sort,
  desc,
  onSortChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  tabActions,
}: AccountsToolbarProps): JSX.Element {
  const { t, lang } = useT("accounts");
  const { t: tc } = useT();

  const options = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    return Object.fromEntries(
      FILTER_DIMENSIONS.map((dimension) => [
        dimension,
        filterOptions(accounts, dimension, t, nowSec),
      ]),
    ) as Record<FilterDimension, FilterOption[]>;
  }, [accounts, t]);

  const groupCounts = useMemo(() => {
    const counts: Record<StatusGroup, number> = { active: 0, attention: 0, disabled: 0 };
    for (const option of options.status) {
      counts[statusGroup(option.value as AccountStatus)] += option.count;
    }
    return counts;
  }, [options.status]);

  const tab = statusFilterGroup(filters.status) ?? ALL;
  const issueOptions = options.status.filter(
    (option) => statusGroup(option.value as AccountStatus) === "attention",
  );
  const issue = filters.status === "attention" ? undefined : filters.status;
  const showIssue = tab === "attention" && (issueOptions.length > 1 || issue !== undefined);

  const selectDimensions = SELECT_DIMENSIONS.filter(
    (dimension) => options[dimension].length > 1 || filters[dimension] !== undefined,
  );
  const hasFilters =
    Boolean(filters.q) || FILTER_DIMENSIONS.some((dimension) => filters[dimension] !== undefined);
  const showTabs = !loading && (accounts.length > 0 || filters.status !== undefined);
  const showSort = accounts.length > 1 || sort !== undefined;
  // The page size closes the filter row, on its right.
  const pageSizeControl =
    pageSize !== undefined && pageSizeOptions?.length && onPageSizeChange ? (
      <PageSizeSelect onChange={onPageSizeChange} options={pageSizeOptions} value={pageSize} />
    ) : null;

  return (
    // The gap under the tab hairline matches the padding under the filter row (the card's p-3 /
    // sm:p-4), so the filter row sits centred between the hairline and the table.
    <div className="flex min-w-0 flex-col gap-3 sm:gap-4" data-slot="accounts-toolbar">
      {showTabs ? (
        <StatusTabs
          counts={groupCounts}
          end={tabActions}
          onValueChange={(next) =>
            onFiltersChange({ status: next === ALL ? undefined : (next as AccountStatusFilter) })
          }
          total={accounts.length}
          value={tab}
        />
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The search gives way (down to 160 px) so the selects and the page size share one row. */}
        <InputGroup className="w-full sm:w-auto sm:min-w-40 sm:max-w-64 sm:flex-1">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("filter.search")}
            autoComplete="off"
            onChange={(event) => onFiltersChange({ q: event.target.value || undefined })}
            placeholder={t("filter.search")}
            type="search"
            value={filters.q ?? ""}
          />
        </InputGroup>

        {/* Phones: the selects scroll sideways in their own row. From sm up the wrapper drops
            out of the layout and the selects wrap with the search. */}
        {loading ? null : (
          <div className="flex min-w-0 items-center gap-2 max-sm:w-full max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden sm:contents">
            {showSort ? <SortSelect desc={desc} onChange={onSortChange} sort={sort} /> : null}

            {showIssue ? (
              <FilterSelect
                label={t("filter.dim.issue")}
                onValueChange={(value) =>
                  onFiltersChange({ status: (value as AccountStatus | undefined) ?? "attention" })
                }
                options={issueOptions}
                total={groupCounts.attention}
                value={issue}
              />
            ) : null}

            {selectDimensions.map((dimension) => (
              <FilterSelect
                key={dimension}
                label={t(`filter.dim.${dimension}`)}
                onValueChange={(value) => onFiltersChange({ [dimension]: value })}
                options={options[dimension]}
                total={accounts.length}
                value={filters[dimension]}
              />
            ))}

            {hasFilters ? (
              <Button
                aria-label={tc("actions.clearFilters")}
                className="px-2"
                onClick={onClearFilters}
                variant="quiet"
              >
                {t("filter.clear")}
              </Button>
            ) : null}

            {/* The result count and the page size share the row's end. */}
            <div className="ms-auto flex shrink-0 items-center gap-2">
              {hasFilters ? (
                <span
                  aria-live="polite"
                  className="whitespace-nowrap ps-1 text-meta text-muted-foreground tabular-nums"
                >
                  {t("filter.results", {
                    shown: formatNumber(shown, lang),
                    total: formatNumber(accounts.length, lang),
                  })}
                </span>
              ) : null}
              {pageSizeControl}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
