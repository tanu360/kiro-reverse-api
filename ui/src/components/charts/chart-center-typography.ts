export const chartCenterContainerClassName =
  "@container/chart-center size-full min-w-0";

/** Primary stat — ~22% of center width, clamped between text-sm and text-3xl. Tabular figures. */
export const chartCenterValueClassName =
  "font-semibold tabular-nums tracking-tight leading-none text-[clamp(0.75rem,22cqw,1.875rem)]";

/** Supporting label — ~9% of center width, clamped between 10px and text-xs, muted. */
export const chartCenterLabelClassName =
  "max-w-full truncate leading-tight text-muted-foreground text-[clamp(0.625rem,9cqw,0.75rem)]";
