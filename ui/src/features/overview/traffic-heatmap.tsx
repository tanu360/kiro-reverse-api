import { useQuery } from "@tanstack/react-query";
import { type JSX, type ReactNode, useMemo } from "react";
import { DisplayEmail } from "@/components/shared/display-email";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { heatmapQuery } from "@/lib/api/observe";
import type { HeatmapCell } from "@/lib/api/types";
import { formatNumber, formatTime } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { cellOpacity, HOUR, HOUR_PAIR_WINDOW, topAccounts, windowCells } from "./aggregate";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "./colors";

const TOP_ACCOUNTS = 5;
// An 8rem label column plus 60 cells of at least about 3.5 px; narrower cards scroll inside.
const ROW_GRID = "grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3";

interface HeatRow {
  key: string;
  label: ReactNode;
  /** Plain text for the row's screen-reader summary (masked like the visible label). */
  text: string;
  cells: HeatmapCell[];
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

function HeatCells({
  row,
  maxReq,
  nowUnix,
  summary,
}: {
  row: HeatRow;
  maxReq: number;
  nowUnix: number;
  summary: string;
}): JSX.Element {
  const { t, lang } = useT("overview");
  return (
    <div
      aria-label={summary}
      className="grid h-6 grid-cols-[repeat(60,minmax(0,1fr))] gap-px"
      role="img"
    >
      {row.cells.map((cell) => {
        const { requests, errors } = counts(t, lang, {
          requests: cell.reqs,
          errors: cell.failures,
        });
        return (
          <span
            className="rounded-[2px]"
            data-failed={cell.failures > 0 || undefined}
            key={cell.offset}
            style={{
              backgroundColor: cell.failures > 0 ? FAILED_COLOR : SUCCEEDED_COLOR,
              opacity: cellOpacity(cell.reqs, maxReq),
            }}
            title={t("heatmap.cellTooltip", {
              requests,
              errors,
              time: formatTime(nowUnix - cell.offset * 60, lang),
            })}
          />
        );
      })}
    </div>
  );
}

/** Per-minute requests for all accounts and the five busiest ones over the last hour. */
export function TrafficHeatmap(): JSX.Element {
  const { t, lang } = useT("overview");
  const display = useDisplayEmail();
  const query = useQuery(heatmapQuery(HOUR_PAIR_WINDOW));
  const data = query.data;

  const view = useMemo(() => {
    if (!data) return null;
    const { rows: busiest, rest } = topAccounts(data, TOP_ACCOUNTS, HOUR);
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
    ];
    const maxReq = Math.max(1, ...rows.flatMap((row) => row.cells.map((cell) => cell.reqs)));
    return { rows, rest, maxReq, nowUnix: data.nowUnix, total: sum(rows[0].cells) };
  }, [data, t, display]);

  let body: JSX.Element;
  if (!view) {
    body = query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <div aria-hidden="true" className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
          <Skeleton className="h-6 w-full" key={index} />
        ))}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {query.isError ? (
          <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <p className="sr-only">{t("heatmap.summary", counts(t, lang, view.total))}</p>
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <div className="flex min-w-[26rem] flex-col gap-2">
            {view.rows.map((row) => (
              <div className={ROW_GRID} key={row.key}>
                <div className="sticky left-0 z-[1] min-w-0 truncate bg-card py-0.5 text-sm">
                  {row.label}
                </div>
                <HeatCells
                  maxReq={view.maxReq}
                  nowUnix={view.nowUnix}
                  row={row}
                  summary={t("heatmap.rowSummary", {
                    label: row.text,
                    ...counts(t, lang, sum(row.cells)),
                  })}
                />
              </div>
            ))}
            <div aria-hidden="true" className={cn(ROW_GRID, "text-muted-foreground text-xs")}>
              <span className="sticky left-0 bg-card" />
              <div className="flex justify-between">
                <span>{t("heatmap.oldest")}</span>
                <span>{t("heatmap.newest")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <SectionCard
      description={t("heatmap.description")}
      footer={
        view && view.rest > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t("heatmap.moreAccounts", { count: view.rest })}
          </p>
        ) : undefined
      }
      id="overview-heatmap"
      title={t("heatmap.title")}
    >
      {body}
    </SectionCard>
  );
}
