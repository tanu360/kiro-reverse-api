import { type LucideIcon, MinusIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { numberFormat } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { InfoHint } from "./info-hint";
import { StatCardSkeleton } from "./loading-state";

export interface StatMetric {
  label: string;
  value: ReactNode;
  tone?: "default" | "danger" | "muted";
  wide?: boolean;
  /** Explains the label in a popup that opens on hover, click or tap (info icon on the label). */
  hint?: string;
}

export interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  tone?: "default" | "danger";
  /** value is a fraction: 0.12 = +12 % */
  delta?: { value: number; label: string; goodWhen?: "up" | "down" } | null;
  caption?: ReactNode;
  /** Decorative; wrapped in aria-hidden. */
  sparkline?: ReactNode;
  metrics?: StatMetric[];
  loading?: boolean;
}

/** 0.125 -> "+12.5%", -0.2 -> "-20%", 0 -> "0%" (in the UI language's number format). */
export function formatDelta(fraction: number, lang?: Lang): string {
  const rounded = Math.round(fraction * 1000) / 1000;
  return numberFormat(lang, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(rounded);
}

function DeltaBadge({ delta }: { delta: NonNullable<StatCardProps["delta"]> }): JSX.Element {
  const direction = delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat";
  const goodWhen = delta.goodWhen ?? "up";
  const tone = direction === "flat" ? "neutral" : direction === goodWhen ? "good" : "bad";
  const Icon =
    direction === "up" ? TrendingUpIcon : direction === "down" ? TrendingDownIcon : MinusIcon;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge
        className="tabular-nums"
        data-tone={tone}
        icon={Icon}
        iconStyle="line"
        tone={tone === "good" ? "success" : tone === "bad" ? "destructive" : "neutral"}
      >
        {formatDelta(delta.value)}
      </Badge>
      <span className="text-muted-foreground text-xs">{delta.label}</span>
    </span>
  );
}

function MetricLabel({ metric }: { metric: StatMetric }): JSX.Element {
  if (!metric.hint) {
    return <dt className="line-clamp-2 text-pretty text-muted-foreground">{metric.label}</dt>;
  }
  return (
    <dt className="min-w-0">
      <InfoHint hint={metric.hint}>{metric.label}</InfoHint>
    </dt>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  tone = "default",
  delta,
  caption,
  sparkline,
  metrics,
  loading = false,
}: StatCardProps): JSX.Element {
  if (loading) return <StatCardSkeleton />;

  const danger = tone === "danger";
  return (
    <Card
      className="min-w-0 gap-4 bg-linear-to-t from-primary/5 to-card p-4 shadow-xs dark:bg-card dark:from-card"
      data-slot="stat-card"
      data-tone={tone}
    >
      <div className="flex flex-col gap-1">
        <div
          className={cn(
            "flex size-7 items-center justify-center rounded-lg border bg-muted text-muted-foreground",
            danger && "border-destructive/20 bg-destructive/10 text-destructive-foreground",
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </div>
        <p className="text-muted-foreground text-sm">{label}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={cn(
              "font-medium text-3xl leading-none tabular-nums",
              danger && "text-destructive-foreground",
            )}
          >
            {value}
          </div>
          {delta ? <DeltaBadge delta={delta} /> : null}
        </div>
        {caption ? <div className="text-muted-foreground text-sm">{caption}</div> : null}
      </div>
      {sparkline ? (
        <div aria-hidden="true" className="-mx-1 h-10 min-w-0">
          {sparkline}
        </div>
      ) : null}
      {metrics && metrics.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-xs">
          {metrics.map((metric) => (
            <div
              className={cn("flex min-w-0 flex-col gap-0.5", metric.wide && "col-span-2")}
              key={metric.label}
            >
              <MetricLabel metric={metric} />
              <dd
                className={cn(
                  "truncate font-medium text-sm tabular-nums",
                  metric.tone === "danger" && "text-destructive-foreground",
                  metric.tone === "muted" && "text-muted-foreground",
                )}
              >
                {metric.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}
