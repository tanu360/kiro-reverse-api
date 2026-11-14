import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { accountForecastQuery } from "@/lib/api/accounts";
import type { AccountForecast, AccountForecastResponse } from "@/lib/api/types";
import { dateTimeFormat, formatRelativeTime, unixToDate } from "@/lib/format";
import type { Lang, TFunction } from "@/lib/i18n";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatCreditAmount } from "./account-model";

/** Below this many credits, "left at the reset" reads as none. */
const LEFT_OVER_MIN = 1;

/** The forecast of one account, from the shared GET /accounts/forecast; undefined until it loads. */
export function useAccountForecast(accountId: string): AccountForecast | undefined {
  const { data } = useQuery({
    ...accountForecastQuery(),
    select: (res: AccountForecastResponse) => res.forecasts?.[accountId],
  });
  return data;
}

/** The forecast window in days, 7 until the response says otherwise. */
function useForecastWindow(): number {
  const { data } = useQuery({
    ...accountForecastQuery(),
    select: (res: AccountForecastResponse) => res.windowDays,
  });
  return data ?? 7;
}

function formatDay(unixSec: number, lang: Lang): string {
  return dateTimeFormat(lang, { dateStyle: "medium" }).format(unixToDate(unixSec));
}

/**
 * The compact hint for a list row: only an account that runs out before its credits reset gets
 * one ("Runs out in 4 days, before its credits reset"). Null for every other forecast.
 */
export function forecastHint(
  forecast: AccountForecast | undefined,
  t: TFunction,
  lang: Lang,
  nowMs: number = Date.now(),
): string | null {
  if (forecast?.status !== "runs_out" || !forecast.depletesAt) return null;
  return t("forecast.hint", { relative: formatRelativeTime(forecast.depletesAt, lang, nowMs) });
}

/**
 * The forecast as one sentence for the detail sheet, or null when there is nothing to say (no
 * limit or reset date known, or no credits left, which the meter already shows).
 */
export function forecastSentence(
  forecast: AccountForecast | undefined,
  windowDays: number,
  t: TFunction,
  lang: Lang,
  nowMs: number = Date.now(),
): string | null {
  if (!forecast) return null;
  const rate = formatCreditAmount(forecast.burnPerDay, lang);
  switch (forecast.status) {
    case "runs_out":
      if (!forecast.depletesAt) return null;
      return t("forecast.runsOut", {
        rate,
        relative: formatRelativeTime(forecast.depletesAt, lang, nowMs),
        date: formatDay(forecast.depletesAt, lang),
      });
    case "lasts":
      return forecast.leftAtReset >= LEFT_OVER_MIN
        ? t("forecast.lastsLeftOver", {
            rate,
            left: formatCreditAmount(forecast.leftAtReset, lang),
          })
        : t("forecast.lasts", { rate });
    case "idle":
      return t("forecast.idle", { days: windowDays });
    default:
      return null;
  }
}

/**
 * The detail sheet's forecast line under the reset date: muted, or in the warning colour when
 * the credits run out before they reset. Nothing while the forecast loads or has nothing to say.
 */
export function ForecastLine({
  accountId,
  className,
}: {
  accountId: string;
  className?: string;
}): JSX.Element | null {
  const { t, lang } = useT("accounts");
  const forecast = useAccountForecast(accountId);
  const windowDays = useForecastWindow();
  const text = forecastSentence(forecast, windowDays, t, lang);
  if (!text) return null;
  return (
    <p
      className={cn(
        "text-meta",
        forecast?.status === "runs_out" ? "text-warning-foreground" : "text-muted-foreground",
        className,
      )}
      data-slot="account-forecast"
    >
      {text}
    </p>
  );
}
