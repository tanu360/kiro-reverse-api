import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
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
type PillDimension = Exclude<FilterDimension, "status">;
const PILL_DIMENSIONS: readonly PillDimension[] = ["plan", "auth", "region", "enabled"];

/** The radio value of "All" in a select, and of the All tab. */
const ALL = "all";
/** The radio value of the sort select's "Default" (the server order). */
const DEFAULT_SORT = "default";

/**
 * A "Label: Value" select trigger: a fully rounded hairline pill, the label muted and the value
 * in the text colour. A set filter tints the border and the value with the accent. Touch screens
 * get a real 40 px height rather than an ::after hit area, because the phone row scrolls and
 * would clip an overflowing box.
 */
function pillTriggerClass(active: boolean): string {
  return cn(
    "relative inline-flex h-9 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-transparent ps-3 pe-2.5 text-base text-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring data-popup-open:bg-accent sm:h-8 sm:text-sm pointer-coarse:h-10 dark:border-input [&_svg]:pointer-events-none [&_svg]:shrink-0",
    active && "border-info/40 dark:border-info/50",
  );
}

function PillText({
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
    <>
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className={cn("max-w-40 truncate", active && "text-info-foreground")}>{value}</span>
      {after}
      <ChevronDownIcon aria-hidden="true" className="-me-0.5 size-3.5 text-muted-foreground" />
    </>
  );
}

/** A radio row with its count right-aligned and muted. A pick closes the menu, as in a select. */
function CountItem({
  value,
  label,
  count,
}: {
  value: string;
  label: string;
  count: number;
}): JSX.Element {
  const { lang } = useT();
  return (
    <MenuRadioItem closeOnClick value={value}>
      <span className="flex min-w-36 items-center gap-4">
        <span className="flex-1 truncate">{label}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatNumber(count, lang)}
        </span>
      </span>
    </MenuRadioItem>
  );
}

/** One filter as "Label: Value ▾", with All and each value (and its count) in the menu. */
function PillSelect({
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
  const { t } = useT("accounts");
  const current =
    value === undefined
      ? t("filter.all")
      : (options.find((option) => option.value === value)?.label ?? value);
  return (
    <Menu>
      <MenuTrigger className={pillTriggerClass(value !== undefined)}>
        <PillText active={value !== undefined} label={label} value={current} />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          onValueChange={(next) => onValueChange(next === ALL ? undefined : String(next))}
          value={value ?? ALL}
        >
          <CountItem count={total} label={t("filter.all")} value={ALL} />
          <MenuSeparator />
          {options.map((option) => (
            <CountItem
              count={option.count}
              key={option.value}
              label={option.label}
              value={option.value}
            />
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
      <MenuTrigger className={pillTriggerClass(false)}>
        <PillText
          after={
            sort ? (
              <DirectionIcon
                aria-hidden="true"
                className="-ms-0.5 size-3.5 text-muted-foreground"
              />
            ) : null
          }
          label={t("sort.by")}
          value={sort ? t(`columns.${sort}`) : t("sort.default")}
        />
      </MenuTrigger>
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
        <TabsList
          aria-label={t("filter.status")}
          className="w-max min-w-full justify-start gap-x-1 border-border border-b"
          variant="underline"
        >
          {tabs.map((tab) => (
            <TabsTab className="grow-0 gap-2 px-2.5" key={tab} value={tab}>
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

  const pillDimensions = PILL_DIMENSIONS.filter(
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
              <PillSelect
                label={t("filter.dim.issue")}
                onValueChange={(value) =>
                  onFiltersChange({ status: (value as AccountStatus | undefined) ?? "attention" })
                }
                options={issueOptions}
                total={groupCounts.attention}
                value={issue}
              />
            ) : null}

            {pillDimensions.map((dimension) => (
              <PillSelect
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
                className="ms-auto shrink-0 whitespace-nowrap ps-1 text-[13px] text-muted-foreground tabular-nums"
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
