// Chart colours as CSS variables, so dark mode swaps them. Kept apart from the lazy chart
// modules: importing a constant from one would pull its chart code into the page chunk.

export const SUCCEEDED_COLOR = "var(--chart-line-primary)";
export const FAILED_COLOR = "var(--chart-negative)";

/** Model-mix ring and table dots: top models in order, then "Other". */
export const MODEL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-positive)",
] as const;
export const OTHER_MODEL_COLOR = "var(--chart-4)";
