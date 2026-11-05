import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  ChevronDownIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, useEffect, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Group, GroupSeparator, GroupText } from "@/components/ui/group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { selectTriggerIconClassName } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import type { Account } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
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
 * A "Label: Value" control: the muted label as a group segment, then an outline button with the
 * value and a chevron that opens a menu of radio rows. The button's name spells out "Plan: All",
 * since the label segment is not part of it.
 */
function FilterTrigger({
  label,
  value,
  after,
}: {
  label: string;
  value: string;
  after?: ReactNode;
}): JSX.Element {
  const { t } = useT("accounts");
  return (
    <Group>
      <GroupText aria-hidden="true">{label}</GroupText>
      <GroupSeparator />
      <MenuTrigger
        render={<Button aria-label={t("filter.trigger", { label, value })} variant="outline" />}
      >
        <span className="max-w-36 truncate">{value}</span>
        {after}
        <HugeiconsIcon
          aria-hidden="true"
          className={selectTriggerIconClassName}
          icon={ChevronDownIcon}
        />
      </MenuTrigger>
    </Group>
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
      <FilterTrigger label={label} value={current} />
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
            <HugeiconsIcon icon={DirectionIcon} aria-hidden="true" className="size-3.5" />
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

/** The scroll box's edge fade (ScrollArea's --fade-size): a tab under it reads as cut off. */
const TAB_FADE_PX = 24;

/**
 * Scrolls the track so the selected tab sits centred in it, when the tab is outside the visible
 * part or under an edge fade. Only the track scrolls, never the page.
 */
function revealSelectedTab(list: HTMLElement | null, smooth: boolean) {
  const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
  const viewport = tab?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (!tab || !viewport) return;
  const box = viewport.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (box.width === 0) return;
  const hidden = rect.left < box.left + TAB_FADE_PX || rect.right > box.right - TAB_FADE_PX;
  if (!hidden) return;
  const left = viewport.scrollLeft + rect.left + rect.width / 2 - (box.left + box.width / 2);
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  viewport.scrollTo?.({ left, behavior: smooth && !reduce ? "smooth" : "auto" });
}

/**
 * Keeps the selected tab in view: on load (a `?status=` link, a reload), once the counts replace
 * their placeholders (the track grows, so the scroll set while loading falls short), on every
 * change and whenever the track's width changes. Moves are instant until the list has loaded;
 * after that a picked tab glides into place.
 */
function useSelectedTabInView(value: StatusTab, loading: boolean) {
  const listRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` and `loading` move the tab.
  useEffect(() => {
    const smooth = loadedRef.current;
    if (!loading) loadedRef.current = true;
    revealSelectedTab(listRef.current, smooth);
  }, [value, loading]);
  // A wider or narrower track (counts arriving, a font swap, a rotation) can push it under the fade.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => revealSelectedTab(list, false));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  return listRef;
}

/**
 * All, Active, Needs attention and Disabled, each with its count, as one segmented control that
 * scrolls sideways (fading at the edge) when the row is too narrow; the selected tab is kept in
 * view. `end` sits at the right of the same row, outside the tablist. While `loading` the tabs
 * keep their place, disabled, with a placeholder for each count (zero counts would read as an
 * empty fleet), so the table does not shift when the list arrives.
 */
function StatusTabs({
  value,
  counts,
  total,
  loading,
  onValueChange,
  end,
}: {
  value: StatusTab;
  counts: Record<StatusGroup, number>;
  total: number;
  loading: boolean;
  onValueChange: (value: StatusTab) => void;
  end?: ReactNode;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const listRef = useSelectedTabInView(value, loading);
  const label: Record<StatusTab, string> = {
    all: t("filter.all"),
    active: t("health.active"),
    attention: t("filter.attention"),
    disabled: t("health.disabled"),
  };
  const tabs: StatusTab[] = [ALL, ...STATUS_GROUPS];
  return (
    // Top-aligned: the scrollbar lane under an overflowing track must not push `end` down.
    <div className="flex min-w-0 items-start gap-2">
      <Tabs
        className="min-w-0 flex-1"
        onValueChange={(next) => onValueChange(next as StatusTab)}
        value={value}
      >
        {/* The sideways bar sits in the gap under the track instead of crossing the pills. */}
        <ScrollArea scrollFade scrollbarGutter="overlap">
          <TabsList aria-label={t("filter.status")} ref={listRef} size="sm">
            {tabs.map((tab) => (
              <TabsTab disabled={loading} key={tab} value={tab}>
                {label[tab]}
                {loading ? (
                  // The badge's size, so the track barely moves when the counts arrive.
                  <Skeleton className="h-5 w-7" />
                ) : (
                  <Badge size="sm">{formatNumber(tab === ALL ? total : counts[tab], lang)}</Badge>
                )}
              </TabsTab>
            ))}
          </TabsList>
        </ScrollArea>
      </Tabs>
      {end ? <div className="flex shrink-0 items-center">{end}</div> : null}
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
   * The list has not loaded yet: the search, the status tabs disabled with placeholder counts
   * and a placeholder for the filter row, because zero counts and raw filter values (a URL's
   * `plan=pro`) would read as an empty fleet.
   */
  loading: boolean;
  sort: AccountSort | undefined;
  desc: boolean;
  /** Mirrors a click on a column header; undefined goes back to the server order. */
  onSortChange: (sort: AccountSort | undefined, desc: boolean) => void;
  /** List-wide actions (Export) at the right end of the status tab row. */
  tabActions?: ReactNode;
}

/**
 * Status tabs (All, Active, Needs attention, Disabled, with counts), then a wrapping row: search
 * (a row of its own below a 64rem card), the filter controls ("Sort by", a "Label: Value" select
 * per filter), Clear and the result count. Below a 32rem card the filter controls stay on one
 * row that scrolls sideways, like the tabs, instead of wrapping into a tall stack. It lives in
 * DataTableCard's toolbar slot. A filter is offered only when the list has two or more values of
 * it (or a filter on it is set). Needs attention groups the problem statuses; once it is picked,
 * an Issue select narrows it to one of them.
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
  // One problem status inside Needs attention ("active" and "disabled" are tabs, not issues).
  const issue = tab === "attention" && filters.status !== "attention" ? filters.status : undefined;
  const showIssue = tab === "attention" && (issueOptions.length > 1 || issue !== undefined);

  const selectDimensions = SELECT_DIMENSIONS.filter(
    (dimension) => options[dimension].length > 1 || filters[dimension] !== undefined,
  );
  // A status tab on its own is not a refinement: its badge already gives the count, so Clear
  // and "34 of 120" show only for a search, a select or an Issue.
  const refined =
    Boolean(filters.q) ||
    SELECT_DIMENSIONS.some((dimension) => filters[dimension] !== undefined) ||
    issue !== undefined;
  const showTabs = loading || accounts.length > 0 || filters.status !== undefined;
  const showSort = accounts.length > 1 || sort !== undefined;
  const hasControls = showSort || showIssue || selectDimensions.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-slot="accounts-toolbar">
      {showTabs ? (
        <StatusTabs
          counts={groupCounts}
          end={tabActions}
          loading={loading}
          onValueChange={(next) =>
            onFiltersChange({ status: next === ALL ? undefined : (next as AccountStatusFilter) })
          }
          total={accounts.length}
          value={tab}
        />
      ) : null}

      {/* Below a 64rem card the search has a row of its own and the filters follow under it. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <InputGroup className="@5xl/accounts:w-64">
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

        {loading ? (
          // The filter row's height: a control's (its scroll bar takes no room of its own).
          <Skeleton className="h-9 w-40 sm:h-8 pointer-coarse:h-10" />
        ) : (
          <>
            {hasControls ? (
              // One sideways-scrolling row below a 32rem card; from there up the controls wrap.
              // The 4 px bleed (-m-1 with p-1 inside) keeps the buttons' focus outline unclipped.
              <ScrollArea
                className="-m-1 h-auto w-auto min-w-0"
                scrollFade
                scrollbarGutter="overlap"
              >
                <div className="flex w-max items-center gap-2 p-1 @lg/accounts:w-auto @lg/accounts:flex-wrap">
                  {showSort ? <SortSelect desc={desc} onChange={onSortChange} sort={sort} /> : null}

                  {showIssue ? (
                    <FilterSelect
                      label={t("filter.dim.issue")}
                      onValueChange={(value) =>
                        onFiltersChange({
                          status: (value as AccountStatus | undefined) ?? "attention",
                        })
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
                </div>
              </ScrollArea>
            ) : null}

            {refined ? (
              <>
                <Button
                  aria-label={tc("actions.clearFilters")}
                  onClick={onClearFilters}
                  size="sm"
                  variant="ghost"
                >
                  {t("filter.clear")}
                </Button>
                <span
                  aria-live="polite"
                  className="ms-auto whitespace-nowrap text-meta text-muted-foreground tabular-nums"
                >
                  {t("filter.results", {
                    shown: formatNumber(shown, lang),
                    total: formatNumber(accounts.length, lang),
                  })}
                </span>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
