import { numberFormat } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import type { ChartLabelCount } from "./responsive-chart-label-count";

// Sizes for a bar chart's axes that follow the labels the active language prints, for charts
// whose values or date labels can run long (the all-time usage and traffic charts).

/** A YAxis tick label is mono text-2xs: about this many pixels a character, plus its gap. */
const TICK_CHAR_PX = 6.8;
const TICK_GAP_PX = 10;

/**
 * The right margin that fits the widest count label of a right-hand YAxis for bars up to
 * `peak`, never less than `min`. Above 1,000 the axis prints compact numbers in the UI language
 * (`lang`, as the YAxis does), which some spell longer ("1 mil" in pt-BR, "4,1 mi"); the top
 * tick can round up a step.
 */
export function rightAxisMargin(peak: number, min: number, lang?: Lang): number {
  const top = peak * 1.25;
  if (!(top >= 1000)) return min;
  const widest = numberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(top);
  return Math.max(min, Math.ceil(widest.length * TICK_CHAR_PX) + TICK_GAP_PX);
}

/**
 * How many date labels the x-axis prints: two on a phone-width chart when a label is long
 * ("29 de set."), so neighbours never touch; otherwise three, four from 640 px and six from 768.
 */
export function dateLabelCount(labels: readonly string[]): ChartLabelCount {
  const long = labels.some((label) => label.length > 8);
  return { base: long ? 2 : 3, sm: 4, md: 6 };
}
