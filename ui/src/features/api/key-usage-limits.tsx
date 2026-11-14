import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import type { ApiKey } from "@/lib/api/types";
import { formatCredits, formatFraction, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A limit used past this share turns its meter amber; a spent one turns it red. */
const LIMIT_WARNING = 0.75;

interface LimitRow {
  kind: "tokens" | "credits" | "calls";
  used: number;
  /** 0 = no limit. */
  limit: number;
  format: (value: number) => string;
}

/**
 * A key's token, credit and call limits in the usage sheet: per limit its use against the cap on
 * a full-width meter (amber from 75 %, red once spent), the share used and what is left; a
 * measure without a cap says so and shows what was used. The counters are the key's own, since it
 * was created or its usage last reset, not the range the sheet charts.
 */
export function KeyLimitsCard({ apiKey }: { apiKey: ApiKey }): JSX.Element {
  const { t, lang } = useT("api");
  const count = (value: number) => formatNumber(value, lang);
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
    <SectionCard
      description={t("usage.limitsDescription")}
      descriptionVariant="inline"
      icon={DashboardSpeed02Icon}
      slim
      title={t("usage.limits")}
    >
      <ul className="divide-y divide-border-subtle">
        {rows.map((row) => {
          const capped = row.limit > 0;
          const reached = capped && row.used >= row.limit;
          const share = capped ? row.used / row.limit : 0;
          // Floored to a tenth of a percent, so 9,999,998 of 10,000,000 reads 99.9 %, not 100 %.
          const shown = reached ? 1 : Math.min(0.999, Math.floor(share * 1000) / 1000);
          const tone = reached ? "destructive" : share >= LIMIT_WARNING ? "warning" : "default";
          return (
            <li className="flex flex-col gap-2 px-4 py-3.5 sm:px-6" key={row.kind}>
              <div className="flex items-baseline justify-between gap-3">
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
                  <Badge size="sm" tone="neutral">
                    {t("common:unlimited")}
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
                  <div className="flex items-baseline justify-between gap-3 text-meta text-muted-foreground tabular-nums">
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
