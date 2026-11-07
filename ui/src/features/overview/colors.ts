// Chart colours as CSS variables, so dark mode swaps them. Kept apart from the lazy chart
// modules: importing a constant from one would pull its chart code into the page chunk.

export const SUCCEEDED_COLOR = "var(--chart-1)";
export const FAILED_COLOR = "var(--chart-negative)";
/** The dashed previous-window line: a quiet grey, never a series colour. */
export const PREVIOUS_COLOR = "var(--chart-comparison)";

/**
 * Series colours for the model-mix donut and table dots and the traffic-by-account bars: purple,
 * lavender, fuchsia, periwinkle and lime (index.css --chart-1..5), then "Other" in peach. No grey
 * and no red: a share is not bad news.
 */
export const MODEL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;
export const OTHER_MODEL_COLOR = "var(--chart-other)";
