import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type JSX, lazy, Suspense, useMemo } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { heatmapQuery } from "@/lib/api/observe";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { OverviewRange } from "@/routes/-search";
import { bucketGlobal, RANGE_WINDOWS } from "./aggregate";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "./colors";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const TrafficChart = lazy(() => import("./traffic-chart"));

const RANGES: readonly OverviewRange[] = ["1h", "6h", "24h"];
// Sized by the card's width (SectionCard is a container), not the viewport.
const PLOT_HEIGHT = "h-72 @2xl:h-80";

function isRange(value: unknown): value is OverviewRange {
  return typeof value === "string" && (RANGES as readonly string[]).includes(value);
}

function LegendChip({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}): JSX.Element {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </li>
  );
}

/** Port of Studio's performance overview: succeeded and failed requests over 1, 6 or 24 h. */
export function TrafficCard(): JSX.Element {
  const { t, lang } = useT("overview");
  // An unknown `?range=` must not crash the page, even if it slips past the route validator.
  const { range: rawRange } = useSearch({ from: "/_app/" });
  const range: OverviewRange = isRange(rawRange) ? rawRange : "1h";
  const navigate = useNavigate({ from: "/" });
  const reducedMotion = usePrefersReducedMotion();
  const { windowMin, bucketMin } = RANGE_WINDOWS[range];
  // Only the 1 h view follows SSE ticks; the longer ranges poll every 60 s.
  const query = useQuery(heatmapQuery(windowMin, { live: range === "1h" }));
  const data = query.data;

  const points = useMemo(
    () => (data ? bucketGlobal(data.global.cells, data.nowUnix, bucketMin) : []),
    [data, bucketMin],
  );
  const totals = useMemo(
    () =>
      points.reduce(
        (sum, p) => ({ succeeded: sum.succeeded + p.succeeded, failed: sum.failed + p.failed }),
        { succeeded: 0, failed: 0 },
      ),
    [points],
  );
  const empty = totals.succeeded + totals.failed === 0;

  const items = RANGES.map((value) => ({ value, label: t(`traffic.range.${value}`) }));
  const setRange = (value: unknown) => {
    if (!isRange(value)) return;
    void navigate({
      search: (prev) => ({ ...prev, range: value === "1h" ? undefined : value }),
    });
  };

  const labels = { succeeded: t("traffic.succeeded"), failed: t("traffic.failed") };
  const skeleton = <Skeleton aria-hidden="true" className={`${PLOT_HEIGHT} w-full rounded-lg`} />;

  let body: JSX.Element;
  if (!data) {
    body = query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      skeleton
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {query.isError ? (
          <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs @md:justify-end">
          <LegendChip
            color={SUCCEEDED_COLOR}
            label={labels.succeeded}
            value={formatNumber(totals.succeeded, lang)}
          />
          <LegendChip
            color={FAILED_COLOR}
            label={labels.failed}
            value={formatNumber(totals.failed, lang)}
          />
        </ul>
        <p className="sr-only">
          {t("traffic.summary", {
            succeeded: formatNumber(totals.succeeded, lang),
            failed: formatNumber(totals.failed, lang),
          })}
        </p>
        <div className="relative">
          <div aria-hidden="true">
            <Suspense fallback={skeleton}>
              <TrafficChart
                labels={labels}
                lang={lang}
                points={points}
                reducedMotion={reducedMotion}
              />
            </Suspense>
          </div>
          {empty ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {/* Backdrop so the message does not sit on the gridlines: the panel's own fill (the
                  card at 40 % over the page) at 80 %. */}
              <div className="rounded-xl bg-surface-inset/80 backdrop-blur-[1px]">
                <EmptyState
                  description={t("traffic.noTrafficBody")}
                  icon={Pulse01Icon}
                  title={t("traffic.noTraffic")}
                  variant="compact"
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <SectionCard
      actions={
        <Select items={items} onValueChange={setRange} value={range}>
          <SelectTrigger aria-label={t("traffic.range")} className="w-auto min-w-28" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
      description={t(`traffic.description.${range}`)}
      id="overview-traffic"
      title={t("traffic.title")}
    >
      {body}
    </SectionCard>
  );
}
