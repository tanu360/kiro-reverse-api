import { ArrowUpRight01Icon, GridViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type JSX,
  lazy,
  memo,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TooltipContent } from "@/components/charts/tooltip/tooltip-content";
import { DisplayEmail } from "@/components/shared/display-email";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { heatmapQuery } from "@/lib/api/observe";
import type { HeatmapCell } from "@/lib/api/types";
import { dateTimeFormat, formatNumber, formatTime, unixToDate } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { HOUR, heatFailure, heatLevel, mergeCells, windowCells } from "./aggregate";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "./colors";
import { useTotalsFailed } from "./status-cards";

// The shared chart tooltip box, loaded on the first hover so the chart code stays out of the page.
const TooltipBox = lazy(() =>
  import("@/components/charts/tooltip/tooltip-box").then((module) => ({
    default: module.TooltipBox,
  })),
);

/** TooltipBox's gap between the cell and a panel beside it, and its inset from the sides. */
const SIDE_OFFSET = 16;
const EDGE_GAP = 8;
/** Gap between the row and a panel above or below it. */
const ROW_GAP = 8;

interface PanelSize {
  width: number;
  height: number;
}

/**
 * Where the panel goes when it cannot sit beside the cell (a narrow card) or the cell was tapped
 * (the finger is on it): above the row, or below it when the card has no room above, centred on
 * the cell and kept inside the card. The cell and its row label stay in view.
 */
function stackedPosition(
  hover: Hover,
  panel: PanelSize,
  containerWidth: number,
): { left: number; top: number } | null {
  const fitsRight = hover.x + SIDE_OFFSET + panel.width <= containerWidth - EDGE_GAP;
  const fitsLeft = hover.x - SIDE_OFFSET - panel.width >= EDGE_GAP;
  if (!hover.touch && (fitsRight || fitsLeft)) return null;
  const above = hover.top - ROW_GAP - panel.height;
  const maxLeft = Math.max(EDGE_GAP, containerWidth - panel.width - EDGE_GAP);
  return {
    left: Math.min(Math.max(hover.x - panel.width / 2, EDGE_GAP), maxLeft),
    top: above >= 0 ? above : hover.bottom + ROW_GAP,
  };
}

/** One cell's minute, row and counts in the charts' tooltip panel. */
function HeatTooltip({
  hover,
  containerRef,
  labels,
}: {
  hover: Hover;
  containerRef: RefObject<HTMLDivElement | null>;
  labels: { requests: string; errors: string };
}): JSX.Element {
  const box = containerRef.current;
  const containerWidth = box?.clientWidth ?? 0;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<PanelSize | null>(null);
  // The panel's size, read before paint after every render (the content changes per cell): the
  // box is portalled into the container, so the panel is the content's ancestor that is the
  // container's direct child.
  useLayoutEffect(() => {
    let node = contentRef.current?.parentElement ?? null;
    while (node && node.parentElement !== box) node = node.parentElement;
    if (!node) return;
    const next = { width: node.offsetWidth, height: node.offsetHeight };
    setPanel((prev) => (prev?.width === next.width && prev.height === next.height ? prev : next));
  });
  const stacked = panel ? stackedPosition(hover, panel, containerWidth) : null;
  return (
    <TooltipBox
      // Its own width wherever it sits: an absolute box near the card's edge would otherwise
      // shrink to the room left there, and the side and the stacking are picked from that width.
      className="w-max max-w-full"
      containerHeight={box?.clientHeight ?? 0}
      containerRef={containerRef}
      containerWidth={containerWidth}
      // A new box when the panel moves between beside and stacked, so it opens in place.
      key={stacked ? "stacked" : "beside"}
      flipped={stacked ? false : undefined}
      left={stacked?.left}
      replayOnFlip={!stacked}
      top={stacked?.top}
      visible
      x={hover.x}
      y={hover.y}
    >
      <div ref={contentRef}>
        <TooltipContent
          meta={hover.label}
          mono
          rows={[
            { color: SUCCEEDED_COLOR, label: labels.requests, value: hover.requests },
            { color: FAILED_COLOR, label: labels.errors, value: hover.errors },
          ]}
          title={hover.time}
        />
      </div>
    </TooltipBox>
  );
}

const TOP_ACCOUNTS = 5;
/*
 * Sized by the card (SectionCard is a container). Narrow cards put the label and the row total
 * on one line above the cells, so the 60 cells get the full width and nothing scrolls sideways;
 * from 28rem the label, the cells and the total sit side by side, and from 48rem the label
 * column widens so an email is not cut while the cells have room to spare.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @md:grid-cols-[10rem_minmax(0,1fr)_3.5rem] @3xl:grid-cols-[14rem_minmax(0,1fr)_3.5rem]";
const CELLS_PLACEMENT = "order-last col-span-2 @md:order-none @md:col-span-1";
/*
 * Cards under 56rem draw 30 two-minute cells, wider ones the 60 minutes: either way a cell stays
 * about 9 to 16 px, a small square tile rather than a thin stripe. CSS picks the grid.
 */
const NARROW_GRID = "grid grid-cols-[repeat(30,minmax(0,1fr))] gap-px @md:gap-0.5 @4xl:hidden";
const WIDE_GRID = "hidden grid-cols-[repeat(60,minmax(0,1fr))] gap-0.5 @4xl:grid";
const NARROW_SPAN = 2;
// The volume ramp (index.css chart-scale-01..05), written out so Tailwind sees every class.
const LEVEL_CLASS = {
  1: "bg-chart-scale-01",
  2: "bg-chart-scale-02",
  3: "bg-chart-scale-03",
  4: "bg-chart-scale-04",
  5: "bg-chart-scale-05",
} as const;
/** Positions of the -45, -30 and -15 minute ticks: the centre of that minute's cell. */
const TICKS = [45, 30, 15] as const;

interface HeatRow {
  key: string;
  label: ReactNode;
  /** Plain text for the row's screen-reader summary and tooltip (masked like the label). */
  text: string;
  cells: HeatmapCell[];
  /** The same minutes in two-minute cells, for narrow cards. */
  pairs: HeatmapCell[];
  total: number;
}

interface Hover {
  key: string;
  /** The cell's centre, in container px. */
  x: number;
  y: number;
  /** The top and bottom of the cell's row (its label included), in container px. */
  top: number;
  bottom: number;
  /** Tapped rather than pointed at: the panel goes above or below the row, clear of the finger. */
  touch: boolean;
  time: string;
  label: string;
  requests: string;
  errors: string;
}

function sum(cells: readonly HeatmapCell[]): { requests: number; errors: number } {
  return cells.reduce(
    (total, cell) => ({
      requests: total.requests + cell.reqs,
      errors: total.errors + cell.failures,
    }),
    { requests: 0, errors: 0 },
  );
}

/** Plural-aware "{n} requests" and "{n} errors"; `n` is grouped, `count` picks the form. */
function counts(
  t: TFunction,
  lang: Lang,
  value: { requests: number; errors: number },
): { requests: string; errors: string } {
  return {
    requests: t("heatmap.requests", {
      count: value.requests,
      n: formatNumber(value.requests, lang),
    }),
    errors: t("heatmap.errors", { count: value.errors, n: formatNumber(value.errors, lang) }),
  };
}

/**
 * One grid of a row's cells (one per `span` minutes), each as tall as it is wide up to 16 px.
 * Memoised, so a hover elsewhere does not redraw them.
 */
const HeatGrid = memo(function HeatGrid({
  cells,
  span,
  rowIndex,
  maxReq,
  className,
}: {
  cells: readonly HeatmapCell[];
  span: number;
  rowIndex: number;
  maxReq: number;
  className: string;
}): JSX.Element {
  return (
    <div className={className}>
      {cells.map((cell) => {
        const empty = cell.reqs === 0 && cell.failures === 0;
        const failure = heatFailure(cell.reqs, cell.failures);
        return (
          <span
            className={cn(
              "aspect-square max-h-4 rounded-xs hover:outline hover:-outline-offset-1 hover:outline-border-strong",
              failure === "alert" ? "bg-chart-negative" : LEVEL_CLASS[heatLevel(cell.reqs, maxReq)],
              failure === "some" && "heat-fail",
            )}
            data-cell={`${rowIndex}:${span}:${cell.offset}`}
            data-empty={empty || undefined}
            data-failed={failure === "none" ? undefined : failure}
            key={cell.offset}
          />
        );
      })}
    </div>
  );
});

/** A row's cells as one image with its summary; the card's width picks the grid. */
function HeatCells({
  row,
  rowIndex,
  maxReq,
  summary,
}: {
  row: HeatRow;
  rowIndex: number;
  maxReq: { minute: number; pair: number };
  summary: string;
}): JSX.Element {
  return (
    <div aria-label={summary} className={CELLS_PLACEMENT} role="img">
      <HeatGrid
        cells={row.pairs}
        className={NARROW_GRID}
        maxReq={maxReq.pair}
        rowIndex={rowIndex}
        span={NARROW_SPAN}
      />
      <HeatGrid
        cells={row.cells}
        className={WIDE_GRID}
        maxReq={maxReq.minute}
        rowIndex={rowIndex}
        span={1}
      />
    </div>
  );
}

/**
 * Per-minute requests for all accounts and the five busiest ones over the last hour. The server
 * sends only those five (top=5) and counts the other busy accounts in `restCount`, which the
 * header subtitle shows as "Top 5 of N".
 */
export function TrafficHeatmap(): JSX.Element {
  const { t, lang } = useT("overview");
  const display = useDisplayEmail();
  const query = useQuery(heatmapQuery(HOUR, { top: TOP_ACCOUNTS }));
  const totalsFailed = useTotalsFailed();
  const data = query.data;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const view = useMemo(() => {
    if (!data) return null;
    // The server sends the busiest first (by requests, failures included); a row without
    // traffic in the hour is left out, should one come.
    const busiest = data.accounts
      .filter((account) => account.cells.some((cell) => cell.offset < HOUR && cell.reqs > 0))
      .slice(0, TOP_ACCOUNTS);
    const rows: HeatRow[] = [
      {
        key: data.global.accountId,
        label: <span className="font-medium">{t("heatmap.global")}</span>,
        text: t("heatmap.global"),
        cells: windowCells(data.global.cells, HOUR),
      },
      ...busiest.map((account) => ({
        key: account.accountId,
        label: <DisplayEmail email={account.email} id={account.accountId} />,
        text: display(account.email, account.accountId),
        cells: windowCells(account.cells, HOUR),
      })),
    ].map((row) => ({
      ...row,
      pairs: mergeCells(row.cells, NARROW_SPAN),
      total: sum(row.cells).requests,
    }));
    const busiestCell = (pick: (row: HeatRow) => HeatmapCell[]) =>
      Math.max(1, ...rows.flatMap((row) => pick(row).map((cell) => cell.reqs)));
    const maxReq = {
      minute: busiestCell((row) => row.cells),
      pair: busiestCell((row) => row.pairs),
    };
    return {
      rows,
      maxReq,
      nowUnix: data.nowUnix,
      total: sum(rows[0].cells),
      shown: busiest.length,
      rest: Math.max(0, data.restCount ?? 0),
    };
  }, [data, t, display]);

  // One listener for every cell: the tooltip follows the cell under the pointer, or (touch) the
  // tapped cell, where it stays until the next tap.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = containerRef.current;
    // A tap can be retargeted to a nearby label (touch adjustment); the point itself is exact.
    const target =
      (event.target as HTMLElement).closest<HTMLElement>("[data-cell]") ??
      document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-cell]");
    if (!view || !box || !target) {
      if (hover) setHover(null);
      return;
    }
    const key = target.dataset.cell ?? "";
    if (hover?.key === key) return;
    // rowIndex:span:offset, the offset being the cell's newest minute.
    const [rowIndex, span, offset] = key.split(":").map(Number);
    const row = view.rows[rowIndex];
    if (!row) return;
    const minutes = row.cells.filter((c) => c.offset >= offset && c.offset < offset + span);
    if (minutes.length === 0) return;
    const total = sum(minutes);
    const newest = view.nowUnix - offset * 60;
    const cellBox = target.getBoundingClientRect();
    const rowBox = (
      target.closest<HTMLElement>("[data-heat-row]") ?? target
    ).getBoundingClientRect();
    const outer = box.getBoundingClientRect();
    setHover({
      key,
      x: cellBox.left + cellBox.width / 2 - outer.left,
      y: cellBox.top + cellBox.height / 2 - outer.top,
      top: rowBox.top - outer.top,
      bottom: rowBox.bottom - outer.top,
      touch: event.pointerType === "touch",
      // "11:52 – 11:53 AM": the range in the language's own short form.
      time:
        span > 1
          ? dateTimeFormat(lang, { timeStyle: "short" }).formatRange(
              unixToDate(newest - (span - 1) * 60),
              unixToDate(newest),
            )
          : formatTime(newest, lang),
      label: row.text,
      requests: formatNumber(total.requests, lang),
      errors: formatNumber(total.errors, lang),
    });
  };

  let body: JSX.Element;
  if (!view) {
    if (query.isError) {
      body = totalsFailed ? (
        <ErrorState notLoaded />
      ) : (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      );
    } else {
      body = (
        <div aria-hidden="true" className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
            <Skeleton className="h-4 w-full" key={index} />
          ))}
        </div>
      );
    }
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {query.isError && !totalsFailed ? (
          <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <p className="sr-only">{t("heatmap.summary", counts(t, lang, view.total))}</p>
        {view.total.requests === 0 ? (
          <EmptyState
            description={t("traffic.noTrafficBody")}
            icon={GridViewIcon}
            title={t("heatmap.empty")}
            variant="compact"
          />
        ) : (
          <div
            className="relative flex flex-col gap-3 @md:gap-2"
            onPointerDown={onPointerMove}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") setHover(null);
            }}
            onPointerMove={onPointerMove}
            ref={containerRef}
          >
            {view.rows.map((row, rowIndex) => (
              <div className={ROW_GRID} data-heat-row key={row.key}>
                <div className="min-w-0 truncate text-sm">{row.label}</div>
                <HeatCells
                  maxReq={view.maxReq}
                  row={row}
                  rowIndex={rowIndex}
                  summary={t("heatmap.rowSummary", {
                    label: row.text,
                    ...counts(t, lang, sum(row.cells)),
                  })}
                />
                <span
                  aria-hidden="true"
                  className="text-right text-meta text-muted-foreground tabular-nums"
                >
                  {formatNumber(row.total, lang)}
                </span>
              </div>
            ))}
            <div aria-hidden="true" className={ROW_GRID}>
              <span className="hidden @md:block" />
              <div className={cn("relative h-4", CELLS_PLACEMENT)}>
                <span className="chart-tick absolute start-0">{t("heatmap.oldest")}</span>
                {TICKS.map((minutes) => (
                  <span
                    className={cn(
                      "chart-tick absolute -translate-x-1/2",
                      minutes !== 30 && "hidden @md:block",
                    )}
                    key={minutes}
                    style={{ left: `${((HOUR - minutes - 0.5) / HOUR) * 100}%` }}
                  >
                    {formatNumber(-minutes, lang)}
                  </span>
                ))}
                <span className="chart-tick absolute end-0">{t("heatmap.newest")}</span>
              </div>
            </div>
            {hover ? (
              <Suspense fallback={null}>
                <HeatTooltip
                  containerRef={containerRef}
                  hover={hover}
                  labels={{
                    requests: t("heatmap.tooltipRequests"),
                    errors: t("heatmap.tooltipErrors"),
                  }}
                />
              </Suspense>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <SectionCard
      actions={
        <Button
          aria-label={t("heatmap.viewAllLabel")}
          render={<Link to="/accounts" />}
          size="sm"
          variant="ghost"
        >
          {t("heatmap.viewAll")}
          <HugeiconsIcon icon={ArrowUpRight01Icon} aria-hidden="true" />
        </Button>
      }
      description={
        // One subtitle, "Top 5 of 73 · last 60 min", not two muted runs side by side.
        view && view.rest > 0
          ? t("heatmap.descriptionTop", {
              shown: formatNumber(view.shown, lang),
              total: formatNumber(view.shown + view.rest, lang),
            })
          : t("heatmap.description")
      }
      descriptionVariant="inline"
      icon={GridViewIcon}
      id="overview-heatmap"
      title={t("heatmap.title")}
    >
      {body}
    </SectionCard>
  );
}
