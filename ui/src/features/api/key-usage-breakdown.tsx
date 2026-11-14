import type { IconSvgElement } from "@hugeicons/react";
import { type JSX, lazy, Suspense, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Skeleton } from "@/components/ui/skeleton";
import { MODEL_COLORS, OTHER_MODEL_COLOR } from "@/features/overview/colors";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { ApiKeyUsageBreakdownItem } from "@/lib/api/api-key-usage";
import { formatNumber, formatPercent } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";

const ModelMixDonut = lazy(() => import("@/features/overview/model-mix-donut"));

/** Slices named one by one; the rest share one "Other" slice, as the Overview's model mix. */
const NAMED_SLICES = 5;

interface Slice {
  key: string;
  label: string;
  requests: number;
  failed: number;
  color: string;
}

export interface UsageBreakdownCardProps {
  kind: "models" | "accounts";
  title: string;
  icon: IconSvgElement;
  items: ApiKeyUsageBreakdownItem[] | undefined;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * One usage row split by model or by account: a donut of the request shares beside a list of the
 * five busiest and "Other", hover linked both ways. Accounts show their email (masked in privacy
 * mode), "Deleted account" for one that no longer exists, and "No account" for requests that
 * reached none.
 */
export function UsageBreakdownCard({
  kind,
  title,
  icon,
  items,
  loading,
  error,
  onRetry,
  retrying,
}: UsageBreakdownCardProps): JSX.Element {
  const { t, lang } = useT("api");
  const displayEmail = useDisplayEmail();
  const reducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState<number | null>(null);

  const slices = useMemo((): Slice[] => {
    if (!items) return [];
    const name = (item: ApiKeyUsageBreakdownItem): string => {
      if (kind === "models") return item.id || t("usage.noModel");
      if (!item.id) return t("usage.noAccount");
      return item.label ? displayEmail(item.label, item.id) : t("usage.deletedAccount");
    };
    const named = items.slice(0, NAMED_SLICES).map((item, index) => ({
      key: item.id || "-",
      label: name(item),
      requests: item.requests,
      failed: item.failed,
      color: MODEL_COLORS[index % MODEL_COLORS.length],
    }));
    const rest = items.slice(NAMED_SLICES);
    if (rest.length === 0) return named;
    return [
      ...named,
      {
        key: "other",
        label: t("usage.otherItems", { count: rest.length, n: formatNumber(rest.length, lang) }),
        requests: rest.reduce((sum, item) => sum + item.requests, 0),
        failed: rest.reduce((sum, item) => sum + item.failed, 0),
        color: OTHER_MODEL_COLOR,
      },
    ];
  }, [items, kind, t, displayEmail, lang]);
  const total = slices.reduce((sum, slice) => sum + slice.requests, 0);
  const ring = useMemo(
    () =>
      slices.map((slice) => ({
        label: slice.label,
        value: slice.requests,
        maxValue: total,
        color: slice.color,
      })),
    [slices, total],
  );

  let body: JSX.Element;
  if (!items && error) {
    body = (
      <div className="px-4 py-4 sm:px-6">
        <ErrorState
          compact
          error={error}
          onRetry={onRetry}
          retrying={retrying}
          title={t("usage.breakdownFailed")}
        />
      </div>
    );
  } else if (loading || !items) {
    body = (
      <div aria-hidden="true" className="flex flex-col items-center gap-4 px-4 py-4 sm:px-6">
        <Skeleton className="aspect-square w-full max-w-40 rounded-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  } else if (total === 0) {
    body = (
      <div className="px-4 py-4 sm:px-6">
        <EmptyState icon={icon} title={t("usage.emptyTitle")} variant="compact" />
      </div>
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col @md:flex-row @md:items-center">
        <figure
          aria-label={t(kind === "models" ? "usage.modelsChart" : "usage.accountsChart")}
          className="w-full max-w-48 shrink-0 self-center px-4 py-4 sm:px-6 @md:max-w-44"
        >
          <Suspense
            fallback={<Skeleton className="mx-auto aspect-square w-full max-w-44 rounded-full" />}
          >
            <ModelMixDonut
              centerLabel={t("usage.centerRequests")}
              fractionDigits={0}
              hoveredIndex={hovered}
              // At most 176 px, against the Overview's 224: a 0.72 hole keeps its ~24 px ring.
              innerRadius={0.72}
              onHoverChange={setHovered}
              reducedMotion={reducedMotion}
              shareLabel={t("usage.share")}
              slices={ring}
            />
          </Suspense>
        </figure>
        <ul
          aria-label={title}
          className="min-w-0 flex-1 divide-y divide-border-subtle border-border-subtle border-t @md:self-stretch @md:border-s @md:border-t-0"
        >
          {slices.map((slice, index) => (
            <li
              className={cn(
                "flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm transition-opacity motion-reduce:transition-none sm:px-6",
                hovered !== null && hovered !== index && "opacity-50",
              )}
              key={slice.key}
              onPointerEnter={() => setHovered(index)}
              onPointerLeave={() => setHovered(null)}
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-xs"
                style={{ background: slice.color }}
              />
              <TruncatedText
                className={cn(
                  "min-w-0 flex-1",
                  kind === "models" && slice.key !== "other" && "font-mono text-meta",
                )}
              >
                {slice.label}
              </TruncatedText>
              <span className="shrink-0 font-medium tabular-nums">
                <span className="sr-only">
                  {t("usage.requestsCount", {
                    count: slice.requests,
                    n: formatNumber(slice.requests, lang),
                  })}
                </span>
                <span aria-hidden="true">{formatNumber(slice.requests, lang)}</span>
              </span>
              <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
                {formatPercent(slice.requests, total, lang)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <SectionCard
      description={t("usage.byRequests")}
      descriptionVariant="inline"
      icon={icon}
      slim
      title={title}
    >
      {body}
    </SectionCard>
  );
}
