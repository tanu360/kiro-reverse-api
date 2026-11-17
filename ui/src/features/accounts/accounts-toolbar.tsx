import {
  CircleCheckIcon,
  CircleSlashIcon,
  Search01Icon,
  TriangleAlertIcon,
  UsersIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, memo, type ReactNode, useMemo, useRef } from "react";
import {
  FilterBar,
  FilterTrigger,
  PageSizeSelect,
  SortSelect,
  type StatusTab,
  StatusTabs,
} from "@/components/shared/table-toolbar";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useKeyShortcut } from "@/hooks/use-key-shortcut";
import type { Account } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
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
const SELECT_DIMENSIONS: readonly FilterSelectDimension[] = [
  "plan",
  "auth",
  "region",
  "enabled",
  "tag",
];

/** The radio value of "All" in a select, and of the All tab. */
const ALL = "all";

/**
 * A select's option values carry this prefix in the menu, so a value that reads "all" (a tag
 * named All) never collides with the All row.
 */
const OPTION_PREFIX = "=";

/**
 * One filter as "Label: Value ▾", with All and each value (and its count) in the menu. With
 * `masked` (tags, which an operator types freely), emails in the labels are masked under
 * privacy, as the tag badges are.
 */
function FilterSelect({
  label,
  options,
  value,
  total,
  masked = false,
  onValueChange,
}: {
  label: string;
  options: FilterOption[];
  /** The set value; undefined is All. */
  value: string | undefined;
  /** The count next to All. */
  total: number;
  masked?: boolean;
  onValueChange: (value: string | undefined) => void;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const mask = useMaskText();
  const allLabel = t("filter.all");
  // A value that reads like All (a tag named "All") is quoted, in the menu and on the trigger,
  // so it never looks like the unfiltered All row.
  const show = (text: string) => {
    const label = masked ? mask(text) : text;
    return label.trim().toLowerCase() === allLabel.toLowerCase()
      ? t("filter.quoted", { value: label })
      : label;
  };
  const current =
    value === undefined
      ? allLabel
      : show(options.find((option) => option.value === value)?.label ?? value);
  // Each row shows its count; a pick closes the menu, as in a select.
  return (
    <Menu>
      <FilterTrigger label={label} value={current} />
      <MenuPopup align="start">
        <MenuRadioGroup
          onValueChange={(next) =>
            onValueChange(next === ALL ? undefined : String(next).slice(OPTION_PREFIX.length))
          }
          value={value === undefined ? ALL : OPTION_PREFIX + value}
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
              value={OPTION_PREFIX + option.value}
            >
              {show(option.label)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

type AccountTab = typeof ALL | StatusGroup;

interface AccountsToolbarProps {
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
  /** With `pageSizeOptions` and `onPageSizeChange`, a "Rows" select at the end of the filter row. */
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (size: number) => void;
}

/** Each status tab's icon, as the status pills draw them. */
const STATUS_GROUP_ICON = {
  active: CircleCheckIcon,
  attention: TriangleAlertIcon,
  disabled: CircleSlashIcon,
} as const;

/**
 * Status tabs (All, Active, Needs attention, Disabled, with counts), then a wrapping row: search
 * (a row of its own below a 64rem card), the filter controls ("Sort by", a "Label: Value" select
 * per filter), Clear and the result count. Below a 32rem card the filter controls stay on one
 * row that scrolls sideways, like the tabs, instead of wrapping into a tall stack. It lives in
 * DataTableCard's toolbar slot. A filter is offered only when the list has two or more values of
 * it (or a filter on it is set). Needs attention groups the problem statuses; once it is picked,
 * an Issue select narrows it to one of them.
 */
export const AccountsToolbar = memo(function AccountsToolbar({
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
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
}: AccountsToolbarProps): JSX.Element {
  const { t, lang } = useT("accounts");
  const { t: tc } = useT();
  const searchRef = useRef<HTMLInputElement>(null);
  // "/" jumps to the search, as on GitHub and in the docs sites the admins know.
  useKeyShortcut(["/"], (event) => {
    if (!searchRef.current) return;
    event.preventDefault();
    searchRef.current.focus();
    searchRef.current.select();
  });

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

  const tab: AccountTab = statusFilterGroup(filters.status) ?? ALL;
  const tabs: StatusTab<AccountTab>[] = [
    { value: ALL, label: t("filter.all"), count: accounts.length, icon: UsersIcon },
    ...STATUS_GROUPS.map((group) => ({
      value: group,
      label: t(group === "attention" ? "filter.attention" : `health.${group}`),
      count: groupCounts[group],
      icon: STATUS_GROUP_ICON[group],
    })),
  ];
  const sortOptions = ACCOUNT_SORTS.map((column) => ({
    value: column,
    label: t(`columns.${column}`),
  }));
  const issueOptions = options.status.filter(
    (option) => statusGroup(option.value as AccountStatus) === "attention",
  );
  // One problem status inside Needs attention ("active" and "disabled" are tabs, not issues).
  const issue = tab === "attention" && filters.status !== "attention" ? filters.status : undefined;
  const showIssue = tab === "attention" && (issueOptions.length > 1 || issue !== undefined);

  // One tag is already a choice: it splits the tagged accounts from the rest.
  const selectDimensions = SELECT_DIMENSIONS.filter(
    (dimension) =>
      options[dimension].length > (dimension === "tag" ? 0 : 1) || filters[dimension] !== undefined,
  );
  // A status tab on its own is not a refinement: its badge already gives the count, so Clear
  // and "34 of 120" show only for a search, a select or an Issue.
  const refined =
    Boolean(filters.q) ||
    SELECT_DIMENSIONS.some((dimension) => filters[dimension] !== undefined) ||
    issue !== undefined;
  const showTabs = loading || accounts.length > 0 || filters.status !== undefined;
  const showSort = accounts.length > 1 || sort !== undefined;
  const pageSizeControl =
    pageSize !== undefined && pageSizeOptions?.length && onPageSizeChange ? (
      <PageSizeSelect onChange={onPageSizeChange} options={pageSizeOptions} value={pageSize} />
    ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-slot="accounts-toolbar">
      {showTabs ? (
        <StatusTabs
          end={tabActions}
          label={t("filter.status")}
          loading={loading}
          onValueChange={(next) =>
            onFiltersChange({ status: next === ALL ? undefined : (next as AccountStatusFilter) })
          }
          tabs={tabs}
          value={tab}
        />
      ) : null}

      {/* Below a 64rem bar the search and Rows share a line over the filters, which never wrap.
          Clear and the count stay out of the scrolling filters, so a long row never hides them. */}
      <FilterBar
        end={
          !loading && refined ? (
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
                className="whitespace-nowrap text-meta text-muted-foreground tabular-nums"
              >
                {t("filter.results", {
                  shown: formatNumber(shown, lang),
                  total: formatNumber(accounts.length, lang),
                })}
              </span>
            </>
          ) : undefined
        }
        pageSize={pageSizeControl ?? undefined}
        search={
          <InputGroup className="@5xl/filter-bar:w-64 @5xl/filter-bar:shrink-0">
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-keyshortcuts="/"
              aria-label={t("filter.search")}
              autoComplete="off"
              onChange={(event) => onFiltersChange({ q: event.target.value || undefined })}
              // Short, so it fits a phone's row; the label names every field.
              placeholder={t("filter.searchPlaceholder")}
              ref={searchRef}
              type="search"
              value={filters.q ?? ""}
            />
          </InputGroup>
        }
      >
        {loading ? (
          // The filter row's height: a control's.
          <Skeleton className="h-8 w-40 sm:h-9 sm:pointer-coarse:h-10" />
        ) : (
          <>
            {showSort ? (
              <SortSelect
                defaultLabel={t("sort.default")}
                defaultSortDesc={defaultSortDesc}
                desc={desc}
                onChange={onSortChange}
                options={sortOptions}
                sort={sort}
              />
            ) : null}

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
                label={dimension === "tag" ? t("metadata.tagFilter") : t(`filter.dim.${dimension}`)}
                masked={dimension === "tag"}
                onValueChange={(value) => onFiltersChange({ [dimension]: value })}
                options={options[dimension]}
                total={accounts.length}
                // Tag options are keyed in lowercase; a typed ?tag= may differ in case.
                value={dimension === "tag" ? filters.tag?.toLowerCase() : filters[dimension]}
              />
            ))}
          </>
        )}
      </FilterBar>
    </div>
  );
});
