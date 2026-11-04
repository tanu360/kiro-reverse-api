import { ArrowDownIcon, ArrowUpIcon, SearchIcon } from "lucide-react";
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
import { SelectButton } from "@/components/ui/select";
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
  return (
    <MenuTrigger render={<SelectButton className="w-auto min-w-0 shrink-0" />}>
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className={cn(active && "text-info-foreground")}>{value}</span>
      {after}
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
  const DirectionIcon = desc ? ArrowDownIcon : ArrowUpIcon;
  return (
    <Menu>
      <FilterTrigger
        after={
          sort ? (
            <DirectionIcon
              aria-hidden="true"
              className="ms-1 inline size-3.5 align-[-0.125em] text-muted-foreground"
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

type StatusTab = typeof ALL | StatusGroup;

/** All, Active, Needs attention and Disabled, each with its count, over a hairline. */
function StatusTabs({
  value,
  counts,
  total,
  onValueChange,
}: {
  value: StatusTab;
  counts: Record<StatusGroup, number>;
  total: number;
  onValueChange: (value: StatusTab) => void;
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
    <Tabs onValueChange={(next) => onValueChange(next as StatusTab)} value={value}>
      {/* Phones scroll the tabs sideways; the hairline spans the full row either way. */}
      <div className="-mb-px overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <TabsList aria-label={t("filter.status")} className="w-max min-w-full" variant="underline">
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

  return (
    <div className="flex min-w-0 flex-col gap-3" data-slot="accounts-toolbar">
      {showTabs ? (
        <StatusTabs
          counts={groupCounts}
          onValueChange={(next) =>
            onFiltersChange({ status: next === ALL ? undefined : (next as AccountStatusFilter) })
          }
          total={accounts.length}
          value={tab}
        />
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-64">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
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

            {hasFilters ? (
              <span
                aria-live="polite"
                className="ms-auto shrink-0 whitespace-nowrap ps-1 text-meta text-muted-foreground tabular-nums"
              >
                {t("filter.results", {
                  shown: formatNumber(shown, lang),
                  total: formatNumber(accounts.length, lang),
                })}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
