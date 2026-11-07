import { ArrowDown02Icon, ArrowUp02Icon, ChevronDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Group, GroupSeparator, GroupText } from "@/components/ui/group";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { selectTriggerIconClassName } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";

// The pieces a list page's DataTableCard toolbar is built from (Accounts, Requests): status tabs
// with counts, "Label: Value" selects, "Sort by" and "Rows".

/**
 * A "Label: Value" control: the muted label as a group segment, then an outline button with the
 * value and a chevron that opens a menu of radio rows. The button's name spells out "Plan: All",
 * since the label segment is not part of it. Even "All" leaves the button wider than index.css
 * popup-width's icon cut-off (3rem), so a short list such as Rows or Enabled fits its rows instead
 * of taking an icon menu's 11rem past the control (as the pager's Rows select).
 */
export function FilterTrigger({
  label,
  value,
  after,
}: {
  label: string;
  value: string;
  after?: ReactNode;
}): JSX.Element {
  const { t } = useT();
  return (
    <Group>
      <GroupText aria-hidden="true">{label}</GroupText>
      <GroupSeparator />
      <MenuTrigger
        render={
          <Button aria-label={t("table.filterTrigger", { label, value })} variant="outline" />
        }
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

/** The radio value of a sort select's server order ("Default"). */
const DEFAULT_SORT = "default";

/**
 * "Sort by: Usage ↓": the column the table headers sort by, and the direction. With
 * `defaultLabel` the menu starts with the server order, which clears the sort; without it the
 * list always has a sort.
 */
export function SortSelect<S extends string>({
  options,
  sort,
  desc,
  onChange,
  defaultSortDesc,
  defaultLabel,
}: {
  options: readonly { value: S; label: string }[];
  sort: S | undefined;
  desc: boolean;
  onChange: (sort: S | undefined, desc: boolean) => void;
  /** The direction a newly picked column starts in. */
  defaultSortDesc: (sort: S) => boolean;
  defaultLabel?: string;
}): JSX.Element {
  const { t } = useT();
  const DirectionIcon = desc ? ArrowDown02Icon : ArrowUp02Icon;
  const current = options.find((option) => option.value === sort)?.label;
  return (
    <Menu>
      <FilterTrigger
        after={
          sort ? (
            <HugeiconsIcon icon={DirectionIcon} aria-hidden="true" className="size-3.5" />
          ) : null
        }
        label={t("table.sortBy")}
        value={current ?? defaultLabel ?? ""}
      />
      <MenuPopup align="start">
        <MenuRadioGroup
          onValueChange={(value) => {
            if (value === DEFAULT_SORT) {
              onChange(undefined, false);
              return;
            }
            const next = value as S;
            onChange(next, next === sort ? desc : defaultSortDesc(next));
          }}
          value={sort ?? DEFAULT_SORT}
        >
          {defaultLabel ? (
            <MenuRadioItem closeOnClick value={DEFAULT_SORT}>
              {defaultLabel}
            </MenuRadioItem>
          ) : null}
          {options.map((option) => (
            <MenuRadioItem closeOnClick key={option.value} value={option.value}>
              {option.label}
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
                {t("table.sortAsc")}
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="desc">
                {t("table.sortDesc")}
              </MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** "Rows: 25": the page size, as a filter-style select at the end of the filter row. */
export function PageSizeSelect({
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
      {/* Short numbers: the list fits them (the trigger is past the 3rem icon cut-off), not 11rem. */}
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

/** The scroll box's edge fade (ScrollArea's --fade-size): a tab under it reads as cut off. */
const TAB_FADE_PX = 24;

/**
 * Scrolls the track so the selected tab sits centred in it, when the tab is outside the visible
 * part or under an edge fade. Only the track scrolls, never the page.
 */
function revealSelectedTab(list: HTMLElement | null, smooth: boolean) {
  const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
  const viewport = tab?.closest<HTMLElement>(
    '[data-slot="scroll-area-viewport"], [data-slot="tabs-list-scroller"]',
  );
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
function useSelectedTabInView(value: string, loading: boolean) {
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

export interface StatusTab<V extends string> {
  value: V;
  label: string;
  /** Left out when the count could not load: the tab shows no badge. */
  count?: number;
}

/**
 * Status tabs, each with its count, as underlined page tabs over a hairline that scroll sideways
 * (fading at the edge) when the row is too narrow; the selected tab is kept in view and its count
 * is purple. `end` sits at the right of the same row, on the same hairline (outside the tablist).
 * While `loading` the tabs keep their place, disabled, with a placeholder for each count (zero
 * counts would read as an empty list), so the table does not shift when the counts arrive.
 */
export function StatusTabs<V extends string>({
  label,
  tabs,
  value,
  loading,
  onValueChange,
  end,
}: {
  /** The tablist's accessible name. */
  label: string;
  tabs: readonly StatusTab<V>[];
  value: V;
  loading: boolean;
  onValueChange: (value: V) => void;
  end?: ReactNode;
}): JSX.Element {
  const { lang } = useT();
  const listRef = useSelectedTabInView(value, loading);
  return (
    // The tabs and `end` stretch to one height, so their two hairlines meet in one line.
    <div className="flex min-w-0 items-stretch">
      <Tabs
        className="min-w-0 flex-1"
        onValueChange={(next) => onValueChange(next as V)}
        value={value}
      >
        <TabsList aria-label={label} ref={listRef} variant="underline">
          {tabs.map((tab) => (
            <TabsTab disabled={loading} key={tab.value} value={tab.value}>
              {tab.label}
              {loading ? (
                // The badge's size, so the track barely moves when the counts arrive.
                <Skeleton className="h-5 w-7" />
              ) : tab.count === undefined ? null : (
                <Badge
                  className="min-w-5"
                  size="sm"
                  tone={tab.value === value ? "primary" : "neutral"}
                >
                  {formatNumber(tab.count, lang)}
                </Badge>
              )}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>
      {end ? <div className="flex shrink-0 items-center border-b ps-2">{end}</div> : null}
    </div>
  );
}
