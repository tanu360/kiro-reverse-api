import type { TimeBucket } from "@/lib/time-buckets";

// The all-time bucket grid of proxy/usage_alltime.go (newLifetimeLayout), for the mocks: local
// days, Monday weeks, months or years, at most 60 bars from the oldest row to today, and at least
// a week of days.

const DAY = 86_400;
const MAX_BUCKETS = 60;
const MIN_DAYS = 7;

export interface LifetimeGrid {
  bucket: Exclude<TimeBucket, "hour">;
  bucketSeconds: number;
  /** Bucket starts, unix s: the viewer's local midnights. */
  buckets: number[];
  from: number;
  /** The end of the current, partial bucket. */
  to: number;
  /** The bucket that holds ts, or -1 outside the grid. */
  index: (ts: number) => number;
}

function weekStart(day: number): number {
  return day - ((((day + 3) % 7) + 7) % 7);
}

function monthNumber(day: number): number {
  const date = new Date(day * DAY * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function monthDay(month: number): number {
  return Date.UTC(Math.floor(month / 12), month % 12, 1) / 1000 / DAY;
}

/** The grid for rows from `oldestTs` (undefined: none) to `nowUnix`, at `tzOffset` minutes. */
export function lifetimeGrid(
  oldestTs: number | undefined,
  nowUnix: number,
  tzOffset: number,
): LifetimeGrid {
  const off = tzOffset * 60;
  const dayOf = (ts: number) => Math.floor((ts + off) / DAY);
  const today = dayOf(nowUnix);
  const first = Math.min(oldestTs === undefined ? today : dayOf(oldestTs), today - (MIN_DAYS - 1));
  let bucket: LifetimeGrid["bucket"];
  const starts: number[] = [];
  let end: number;
  let indexOfDay: (day: number) => number;
  if (today - first + 1 <= MAX_BUCKETS) {
    bucket = "day";
    for (let day = first; day <= today; day++) starts.push(day);
    end = today + 1;
    indexOfDay = (day) => day - first;
  } else if ((weekStart(today) - weekStart(first)) / 7 + 1 <= MAX_BUCKETS) {
    bucket = "week";
    for (let day = weekStart(first); day <= today; day += 7) starts.push(day);
    end = weekStart(today) + 7;
    indexOfDay = (day) => (weekStart(day) - weekStart(first)) / 7;
  } else if (monthNumber(today) - monthNumber(first) + 1 <= MAX_BUCKETS) {
    bucket = "month";
    for (let month = monthNumber(first); month <= monthNumber(today); month++) {
      starts.push(monthDay(month));
    }
    end = monthDay(monthNumber(today) + 1);
    indexOfDay = (day) => monthNumber(day) - monthNumber(first);
  } else {
    bucket = "year";
    const year = (day: number) => new Date(day * DAY * 1000).getUTCFullYear();
    for (let y = year(first); y <= year(today); y++) starts.push(Date.UTC(y, 0, 1) / 1000 / DAY);
    end = Date.UTC(year(today) + 1, 0, 1) / 1000 / DAY;
    indexOfDay = (day) => year(day) - year(first);
  }
  const firstStart = starts[0] ?? today;
  return {
    bucket,
    bucketSeconds: bucket === "day" ? DAY : bucket === "week" ? 7 * DAY : 0,
    buckets: starts.map((day) => day * DAY - off),
    from: firstStart * DAY - off,
    to: end * DAY - off,
    index: (ts) => {
      const day = dayOf(ts);
      if (day < firstStart || day >= end) return -1;
      return indexOfDay(day);
    },
  };
}
