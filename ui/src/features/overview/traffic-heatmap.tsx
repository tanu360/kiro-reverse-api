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
  useMemo,
  useRef,
  useState,
} from "react";
import { TooltipContent, TooltipHeader } from "@/components/charts/tooltip/tooltip-content";
import { DisplayEmail } from "@/components/shared/display-email";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { heatmapQuery } from "@/lib/api/observe";
import type { HeatmapCell } from "@/lib/api/types";
import { formatNumber, formatTime } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { HOUR, heatFailure, heatLevel, windowCells } from "./aggregate";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "./colors";
import { useTotalsFailed } from "./status-cards";

// The shared chart tooltip box, loaded on the first hover so the chart code stays out of the page.
const TooltipBox = lazy(() =>
  import("@/components/charts/tooltip/tooltip-box").then((module) => ({
    default: module.TooltipBox,
  })),
);

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
  return (
    <TooltipBox
      containerHeight={box?.clientHeight ?? 0}
      containerRef={containerRef}
      containerWidth={box?.clientWidth ?? 0}
      visible
      x={hover.x}
      y={hover.y}
    >
      <TooltipHeader className="flex items-baseline gap-2">
        <span className="font-mono">{hover.time}</span>
        <span className="min-w-0 truncate font-normal text-chart-tooltip-muted text-meta">
          {hover.label}
        </span>
      </TooltipHeader>
      <TooltipContent
        rows={[
          { color: SUCCEEDED_COLOR, label: labels.requests, value: hover.requests },
          { color: FAILED_COLOR, label: labels.errors, value: hover.errors },
        ]}
      />
    </TooltipBox>
  );
}

const TOP_ACCOUNTS = 5;
/*
 * Sized by the card (SectionCard is a container). Narrow cards put the label and the row total
 * on one line above the cells, so the 60 cells get the full width and nothing scrolls sideways;
 * from 28rem the label, the cells and the total sit side by side.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @md:grid-cols-[10rem_minmax(0,1fr)_3.5rem]";
const CELLS_PLACEMENT = "order-last col-span-2 @md:order-none @md:col-span-1";
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
  total: number;
}

interface Hover {
  key: string;
  x: number;
  y: number;
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

/** One row's 60 cells. Memoised, so a hover elsewhere does not redraw them. */
const HeatCells = memo(function HeatCells({
  row,
  rowIndex,
  maxReq,
  summary,
}: {
  row: HeatRow;
  rowIndex: number;
  maxReq: number;
  summary: string;
}): JSX.Element {
  return (
    <div
      aria-label={summary}
      className={cn(
        "grid h-4 grid-cols-[repeat(60,minmax(0,1fr))] gap-px @md:gap-0.5",
        CELLS_PLACEMENT,
      )}
      role="img"
    >
      {row.cells.map((cell) => {
        const empty = cell.reqs === 0 && cell.failures === 0;
        const failure = heatFailure(cell.reqs, cell.failures);
        return (
          <span
            className={cn(
              "rounded-xs hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-foreground/40",
              failure === "alert" ? "bg-chart-negative" : LEVEL_CLASS[heatLevel(cell.reqs, maxReq)],
              failure === "some" && "heat-fail",
            )}
            data-cell={`${rowIndex}:${cell.offset}`}
            data-empty={empty || undefined}
            data-failed={failure === "none" ? undefined : failure}
            key={cell.offset}
          />
        );
      })}
    </div>
  );
});

/**
 * Per-minute requests for all accounts and the five busiest ones over the last hour. The server
 * sends only those five (top=5) and counts the other busy accounts in `restCount`, which the
 * header shows as "Top 5 of N" beside the All link.
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
        total: 0,
      },
      ...busiest.map((account) => ({
        key: account.accountId,
        label: <DisplayEmail email={account.email} id={account.accountId} />,
        text: display(account.email, account.accountId),
        cells: windowCells(account.cells, HOUR),
        total: 0,
      })),
    ].map((row) => ({ ...row, total: sum(row.cells).requests }));
    const maxReq = Math.max(1, ...rows.flatMap((row) => row.cells.map((cell) => cell.reqs)));
    return {
      rows,
      maxReq,
      nowUnix: data.nowUnix,
      total: sum(rows[0].cells),
      shown: busiest.length,
      rest: Math.max(0, data.restCount ?? 0),
    };
  }, [data, t, display]);

  // One listener for every cell: the tooltip follows the cell under the pointer.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = containerRef.current;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!view || !box || !target) {
      if (hover) setHover(null);
      return;
    }
    const key = target.dataset.cell ?? "";
    if (hover?.key === key) return;
    const [rowIndex, offset] = key.split(":").map(Number);
    const row = view.rows[rowIndex];
    const cell = row?.cells.find((c) => c.offset === offset);
    if (!row || !cell) return;
    const cellBox = target.getBoundingClientRect();
    const outer = box.getBoundingClientRect();
    setHover({
      key,
      x: cellBox.left + cellBox.width / 2 - outer.left,
      y: cellBox.top + cellBox.height / 2 - outer.top,
      time: formatTime(view.nowUnix - cell.offset * 60, lang),
      label: row.text,
      requests: formatNumber(cell.reqs, lang),
      errors: formatNumber(cell.failures, lang),
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
            onPointerLeave={() => setHover(null)}
            onPointerMove={onPointerMove}
            ref={containerRef}
          >
            {view.rows.map((row, rowIndex) => (
              <div className={ROW_GRID} key={row.key}>
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
      description={t("heatmap.description")}
      descriptionVariant="inline"
      icon={GridViewIcon}
      id="overview-heatmap"
      meta={
        view && view.rest > 0
          ? t("heatmap.topOf", {
              shown: formatNumber(view.shown, lang),
              total: formatNumber(view.shown + view.rest, lang),
            })
          : undefined
      }
      title={t("heatmap.title")}
    >
      {body}
    </SectionCard>
  );
}
