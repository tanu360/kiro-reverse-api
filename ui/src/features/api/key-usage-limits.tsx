import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { SectionCard } from "@/components/shared/section-card";
import { UnlimitedMark } from "@/components/shared/unlimited-mark";
import { Badge } from "@/components/ui/badge";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiKey } from "@/lib/api/types";
import { formatCredits, formatFraction, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A limit used past this share turns its meter amber; a spent one turns it red. */
const LIMIT_WARNING = 0.75;

/** The counters and caps the card reads: an admin ApiKey or the key holder's own key. */
export type KeyLimitsSource = Pick<
  ApiKey,
  "tokensUsed" | "tokenLimit" | "creditsUsed" | "creditLimit" | "successfulCalls" | "callLimit"
>;

const LIMIT_KINDS = ["tokens", "credits", "calls"] as const;

interface LimitRow {
  kind: (typeof LIMIT_KINDS)[number];
  used: number;
  /** 0 = no limit. */
  limit: number;
  format: (value: number) => string;
}

/**
 * A key's token, credit and call limits in the usage sheet: per limit its use against the cap on
 * a meter (amber from 75 %, red once spent), the share used and what is left; a measure without a
 * cap says so and shows what was used. Three across once the card is wide enough, stacked on a
 * phone. The counters are the key's own, since it was created or its usage last reset, not the
 * range the sheet charts.
 */
export function KeyLimitsCard({
  apiKey,
}: {
  /** Undefined while the key loads: each limit is then a placeholder of its name and figures. */
  apiKey: KeyLimitsSource | undefined;
}): JSX.Element {
  const { t, lang } = useT("api");
  const count = (value: number) => formatNumber(value, lang);
  const header = {
    description: t("usage.limitsDescription"),
    descriptionVariant: "inline",
    icon: DashboardSpeed02Icon,
    slim: true,
    title: t("usage.limits"),
  } as const;
  if (!apiKey) {
    return (
      <SectionCard {...header}>
        <ul
          aria-busy="true"
          className="grid divide-y divide-border-subtle @lg:grid-cols-3 @lg:divide-x @lg:divide-y-0"
        >
          {LIMIT_KINDS.map((kind) => (
            <li className="flex min-w-0 flex-col gap-2 px-4 py-4 sm:px-6" key={kind}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-sm">{t(`keys.${kind}`)}</span>
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-1.5 w-full" />
              <Skeleton className="h-3 w-16" />
            </li>
          ))}
        </ul>
      </SectionCard>
    );
  }
  const rows: LimitRow[] = [
    { kind: "tokens", used: apiKey.tokensUsed, limit: apiKey.tokenLimit ?? 0, format: count },
    {
      kind: "credits",
      used: apiKey.creditsUsed,
      limit: apiKey.creditLimit ?? 0,
      format: (value) => formatCredits(value, 2, lang),
    },
    {
      kind: "calls",
      used: apiKey.successfulCalls ?? 0,
      limit: apiKey.callLimit ?? 0,
      format: count,
    },
  ];

  return (
    <SectionCard {...header}>
      <ul className="grid divide-y divide-border-subtle @lg:grid-cols-3 @lg:divide-x @lg:divide-y-0">
        {rows.map((row) => {
          const capped = row.limit > 0;
          const reached = capped && row.used >= row.limit;
          const share = capped ? row.used / row.limit : 0;
          // Floored to a tenth of a percent, so 9,999,998 of 10,000,000 reads 99.9 %, not 100 %.
          const shown = reached ? 1 : Math.min(0.999, Math.floor(share * 1000) / 1000);
          const tone = reached ? "destructive" : share >= LIMIT_WARNING ? "warning" : "default";
          return (
            <li className="flex min-w-0 flex-col gap-2 px-4 py-4 sm:px-6" key={row.kind}>
              {/* Wraps the figures under the name when a third of the card is too narrow. */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-medium text-sm">{t(`keys.${row.kind}`)}</span>
                {capped ? (
                  <span
                    className={cn(
                      "text-sm tabular-nums",
                      reached && "font-medium text-destructive-foreground",
                    )}
                  >
                    {t("usage.limitValue", {
                      used: row.format(row.used),
                      limit: row.format(row.limit),
                    })}
                  </span>
                ) : (
                  // Centred, not on the baseline: a 20 px badge would push the name 2 px below the
                  // names of the other limits.
                  <Badge className="self-center" size="sm" tone="neutral">
                    <UnlimitedMark />
                  </Badge>
                )}
              </div>
              {capped ? (
                <>
                  <Meter
                    aria-label={t(`keys.${row.kind}Usage`, {
                      used: row.format(row.used),
                      limit: row.format(row.limit),
                    })}
                    max={row.limit}
                    min={0}
                    value={Math.min(row.used, row.limit)}
                  >
                    <MeterTrack className="h-1.5">
                      <MeterIndicator tone={tone} />
                    </MeterTrack>
                  </Meter>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-meta text-muted-foreground tabular-nums">
                    <span>{formatFraction(shown, 1, lang)}</span>
                    <span className={cn(reached && "text-destructive-foreground")}>
                      {reached
                        ? t("usage.limitReached")
                        : t("usage.limitLeft", { n: row.format(row.limit - row.used) })}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-meta text-muted-foreground tabular-nums">
                  {t("usage.limitUsed", { n: row.format(row.used) })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
