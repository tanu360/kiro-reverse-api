import { scaleLinear } from "d3-scale";
import { numberFormat } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import type { ChartLabelCount } from "./responsive-chart-label-count";
import { tickLabels } from "./y-axis-ticks";
import { resolveBarValueDomain } from "./y-domain-utils";

// Sizes for a bar chart's axes that follow the labels the active language prints, for charts
// whose values or date labels can run long (the all-time usage and traffic charts).

/** A YAxis tick label is mono text-2xs: about this many pixels a character, plus its gap. */
const TICK_CHAR_PX = 6.8;
const TICK_GAP_PX = 10;

/**
 * The right margin that fits the widest label of a right-hand YAxis (4 ticks) for bars up to
 * `peak`, never less than `min`. Above 1,000 the axis prints compact numbers in the UI language
 * (`lang`, as the YAxis does), which some spell longer ("1 mil" in pt-BR, "4,1 mi"); the top
 * tick can round up a step. A small fraction (a key's credits) prints the decimals its step
 * needs ("0.002"), the labels BarChart's own value scale gives.
 */
export function rightAxisMargin(peak: number, min: number, lang?: Lang): number {
  const top = peak * 1.25;
  const labels =
    top >= 1000
      ? [numberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(top)]
      : tickLabels(barValueTicks(peak), true, undefined, lang);
  const widest = Math.max(...labels.map((label) => label.length));
  return Math.max(min, Math.ceil(widest * TICK_CHAR_PX) + TICK_GAP_PX);
}

/** The 4 value ticks of a BarChart whose bars reach `peak`: its niced value scale's. */
function barValueTicks(peak: number): number[] {
  return scaleLinear()
    .domain(resolveBarValueDomain({ minValue: 0, maxValue: peak }))
    .nice()
    .ticks(4);
}

/**
 * How many date labels the x-axis prints: two on a phone-width chart when a label is long
 * ("29 de set."), so neighbours never touch; otherwise three, four from 640 px and six from 768.
 */
export function dateLabelCount(labels: readonly string[]): ChartLabelCount {
  const long = labels.some((label) => label.length > 8);
  return { base: long ? 2 : 3, sm: 4, md: 6 };
}
