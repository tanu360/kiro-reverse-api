import { dateTimeFormat } from "./format";
import type { Lang } from "./i18n";

// Labels for the bars of the usage and traffic charts that the server buckets by the viewer's
// offset (proxy/apikey_usage.go, proxy/usage_alltime.go). Pure, so they test on their own.

/**
 * An hour, or a local day, Monday week, month or year. All time picks day, week, month or year
 * from the span of the log.
 */
export type TimeBucket = "hour" | "day" | "week" | "month" | "year";

const DAY_SECONDS = 86_400;

/**
 * The wall clock at a bucket start in the offset the server bucketed with, read back in UTC. The
 * labels then always match the buckets: no two hours share a label across a DST change.
 */
function wallClock(start: number, tzOffset: number): Date {
  return new Date((start + tzOffset * 60) * 1000);
}

/** The axis label: "14:00" for an hour, "Mar 10" for a day or week, "Mar 2026", "2026". */
export function bucketLabel(
  start: number,
  bucket: TimeBucket,
  tzOffset: number,
  lang: Lang,
): string {
  let options: Intl.DateTimeFormatOptions;
  if (bucket === "hour") options = { timeStyle: "short", timeZone: "UTC" };
  else if (bucket === "month") options = { month: "short", year: "numeric", timeZone: "UTC" };
  else if (bucket === "year") options = { year: "numeric", timeZone: "UTC" };
  else options = { month: "short", day: "numeric", timeZone: "UTC" };
  return dateTimeFormat(lang, options).format(wallClock(start, tzOffset));
}

/**
 * The tooltip title: "14:00–15:00" for an hour, "Tue, Mar 10" for a day, "Mar 9 – 15, 2026" for
 * a week, "March 2026" for a month, "2026" for a year.
 */
export function bucketTitle(
  start: number,
  bucket: TimeBucket,
  bucketSeconds: number,
  tzOffset: number,
  lang: Lang,
): string {
  const date = wallClock(start, tzOffset);
  if (bucket === "hour") {
    return `${bucketLabel(start, bucket, tzOffset, lang)}–${bucketLabel(start + bucketSeconds, bucket, tzOffset, lang)}`;
  }
  if (bucket === "week") {
    const format = dateTimeFormat(lang, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    // The week's last day: six days on from its Monday.
    return format.formatRange(date, wallClock(start + 6 * DAY_SECONDS, tzOffset));
  }
  if (bucket === "month") {
    return dateTimeFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  }
  if (bucket === "year") return bucketLabel(start, bucket, tzOffset, lang);
  return dateTimeFormat(lang, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}
