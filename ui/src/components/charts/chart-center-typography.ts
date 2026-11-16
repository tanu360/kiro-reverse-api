export const chartCenterContainerClassName = "@container/chart-center size-full min-w-0";

/**
 * Primary stat — ~22% of center width, clamped between 12 px and the 24 px KPI step. Tabular
 * figures.
 */
export const chartCenterValueClassName =
  "font-semibold tabular-nums tracking-tight leading-none text-[clamp(0.75rem,22cqw,1.5rem)]";

/** Supporting label — text-xs (12 px, the smallest step), muted; truncates in a narrow ring. */
export const chartCenterLabelClassName =
  "max-w-full truncate leading-tight text-muted-foreground text-xs";
