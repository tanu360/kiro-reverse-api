"use client";

// Vendored from bklit @bklit/y-axis (ui.bklit.com/r/y-axis.json). Kiro changes: `side`
// instead of `orientation`, explicit `tickValues`, chart-tick labels (mono, tabular,
// chart-label grey), the UI-language number format, and the `niceTicks` helper.
// The labels are HTML portalled into the chart container, and the component is named
// `YAxis`, so the chart shells keep it outside the series reveal clip with no extra wiring.

import { scaleLinear } from "d3-scale";
import { AnimatePresence, m, useReducedMotion, type Variants } from "motion/react";
import { memo, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { numberFormat } from "@/lib/format";
import {
  useChartPortalContainer,
  useChartStable,
  useSettledYScale,
  useYScale,
} from "./chart-context";
import { normalizeYAxisId } from "./y-axis-scales";
import { resolveYAxisTickCount, Y_AXIS_DEFAULT_TICK_COUNT } from "./y-axis-ticks";

/** Vertical drift (px) of labels fading in / out on a y-domain change. */
const Y_AXIS_LABEL_SHIFT_PX = 8;
const Y_AXIS_LABEL_EASE_OUT = [0.23, 1, 0.32, 1] as const;
const Y_AXIS_LABEL_ENTER_S = 0.4;
const Y_AXIS_LABEL_EXIT_S = 0.25;
const Y_AXIS_LABEL_CLIP_BLEED_PX = 12;
/** Delay between consecutive entering labels (cascade). */
const Y_AXIS_LABEL_STAGGER_S = 0.05;
/** Space between the plot edge and a label. */
const Y_AXIS_LABEL_GAP_PX = 8;

/**
 * Zero-anchored "nice" ticks for a non-negative series whose busiest value is
 * `max`: `scaleLinear().domain([0, max * 1.1]).nice(count).ticks(count)`. The
 * last tick is the nice domain top (35 gives 0, 10, 20, 30, 40), so pass
 * `yDomain={[0, ticks.at(-1)]}` to the chart and the top label sits on the top
 * gridline. `integer` keeps whole-number steps for counts (max 2 gives 0-3).
 * No data (max <= 0) gives `[0, 1]`.
 */
export function niceTicks(
  max: number,
  count = 4,
  { integer = false }: { integer?: boolean } = {},
): number[] {
  if (!(Number.isFinite(max) && max > 0)) {
    return [0, 1];
  }
  const hint = resolveYAxisTickCount(count);
  const ticks = scaleLinear()
    .domain([0, max * 1.1])
    .nice(hint)
    .ticks(hint);
  if (integer && ticks.some((tick) => !Number.isInteger(tick))) {
    const top = Math.max(1, Math.ceil(max * 1.1));
    return Array.from({ length: top + 1 }, (_, tick) => tick);
  }
  return ticks;
}

/**
 * Direction labels travel while the y-domain tweens: `-1` (up) when the
 * domain shrinks — values grow apart and rise — `1` (down) when it grows.
 */
type LabelDrift = -1 | 1;

interface LabelMotion {
  drift: LabelDrift;
  reducedMotion: boolean;
}

const labelVariants: Variants = {
  hidden: ({ drift }: LabelMotion) => ({
    opacity: 0,
    y: -drift * Y_AXIS_LABEL_SHIFT_PX,
  }),
  visible: { opacity: 1, y: 0 },
  exit: ({ drift, reducedMotion }: LabelMotion) => ({
    opacity: 0,
    y: drift * Y_AXIS_LABEL_SHIFT_PX,
    transition: {
      duration: reducedMotion ? 0 : Y_AXIS_LABEL_EXIT_S,
      ease: Y_AXIS_LABEL_EASE_OUT,
    },
  }),
};

interface YAxisProps {
  /** Scale group id (Recharts `yAxisId`). Default: `"left"`. */
  yAxisId?: string | number;
  /** Which side of the plot the labels sit on, inside that chart margin. Default: `"left"`. */
  side?: "left" | "right";
  /**
   * Explicit tick values (e.g. from {@link niceTicks}, shared with
   * `<Grid rowTickValues>`). Default: the settled scale's d3 ticks.
   */
  tickValues?: readonly number[];
  /**
   * Approximate tick count hint for `scale.ticks()` when `tickValues` is not
   * set. Clamped to 1–10. Default: 5.
   */
  numTicks?: number;
  /** Compact large numbers (1,500 as "1.5K"). Default: true */
  formatLargeNumbers?: boolean;
  /** Custom label formatter. Overrides `formatLargeNumbers`. */
  formatValue?: (value: number) => string;
}

function formatLabel(
  value: number,
  formatLargeNumbers: boolean,
  formatValue?: (value: number) => string,
): string {
  if (formatValue) {
    return formatValue(value);
  }
  if (formatLargeNumbers && Math.abs(value) >= 1000) {
    return numberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  return numberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

/** Inclusive data range of a reference band, for axis label highlighting. */
function resolveReferenceDataRange(
  y1: number | undefined,
  y2: number | undefined,
  domain: [number, number],
): [number, number] {
  const dMin = Math.min(domain[0], domain[1]);
  const dMax = Math.max(domain[0], domain[1]);
  const low = y1 ?? dMin;
  const high = y2 ?? dMax;
  return [Math.min(low, high), Math.max(low, high)];
}

function resolveTickLabelColor(
  tickY: number,
  axisId: string,
  yScale: ReturnType<typeof useYScale>,
  referenceAreas: ReturnType<typeof useChartStable>["referenceAreas"],
): string | undefined {
  for (const area of referenceAreas) {
    if (!area.axisLabelColor) {
      continue;
    }
    if (normalizeYAxisId(area.yAxisId) !== axisId) {
      continue;
    }
    const [low, high] = resolveReferenceDataRange(
      area.y1,
      area.y2,
      yScale.domain() as [number, number],
    );
    const topPixel = yScale(high) ?? 0;
    const bottomPixel = yScale(low) ?? 0;
    const bandTop = Math.min(topPixel, bottomPixel);
    const bandBottom = Math.max(topPixel, bottomPixel);
    if (tickY >= bandTop && tickY <= bandBottom) {
      return area.axisLabelColor;
    }
  }
  return undefined;
}

/** Value labels beside the plot, in the left or right chart margin. */
export function YAxis(props: YAxisProps) {
  const { containerRef } = useChartStable();

  const container = useChartPortalContainer(containerRef);
  if (!container) {
    return null;
  }

  return <YAxisInner {...props} container={container} />;
}

const YAxisInner = memo(function YAxisInner({
  yAxisId,
  side = "left",
  tickValues: tickValuesProp,
  numTicks = Y_AXIS_DEFAULT_TICK_COUNT,
  formatLargeNumbers = true,
  formatValue,
  container,
}: YAxisProps & { container: HTMLDivElement }) {
  const { margin, referenceAreas } = useChartStable();
  const yScale = useYScale(yAxisId);
  // Tick values come from the settled (target) domain so a y-domain tween
  // swaps one label set for the next once, instead of churning through every
  // intermediate tick set; positions still follow the live scale each frame.
  const settledYScale = useSettledYScale(yAxisId);
  const reducedMotion = useReducedMotion() ?? false;
  const isLeft = side === "left";
  const axisId = normalizeYAxisId(yAxisId);

  const [settledMin, settledMax] = settledYScale.domain() as [number, number];
  const settledSpan = settledMax - settledMin;
  const [prevSettledSpan, setPrevSettledSpan] = useState(settledSpan);
  const [drift, setDrift] = useState<LabelDrift>(-1);
  if (settledSpan !== prevSettledSpan) {
    setPrevSettledSpan(settledSpan);
    setDrift(settledSpan < prevSettledSpan ? -1 : 1);
  }

  // Keyed on the values, so an inline `tickValues={[…]}` literal stays cheap.
  const tickValuesKey = tickValuesProp?.join(",");
  const tickValues = useMemo(
    () =>
      tickValuesKey === undefined
        ? settledYScale.ticks(resolveYAxisTickCount(numTicks))
        : tickValuesKey.split(",").filter(Boolean).map(Number),
    [settledYScale, numTicks, tickValuesKey],
  );

  const ticks = useMemo(() => {
    return tickValues.map((value) => {
      const y = (yScale(value) ?? 0) + margin.top;
      return {
        value,
        y,
        label: formatLabel(value, formatLargeNumbers, formatValue),
        labelColor: resolveTickLabelColor(y - margin.top, axisId, yScale, referenceAreas),
      };
    });
  }, [tickValues, yScale, margin.top, formatLargeNumbers, formatValue, axisId, referenceAreas]);

  return createPortal(
    <div className="pointer-events-none absolute inset-0" data-slot="chart-y-axis">
      <div
        className="absolute overflow-hidden"
        style={{
          // Clip labels tweening in from far off-scale, with room for a
          // half-height edge label when the chart margin is tight.
          top: -Y_AXIS_LABEL_CLIP_BLEED_PX,
          bottom: -Y_AXIS_LABEL_CLIP_BLEED_PX,
          ...(isLeft ? { left: 0, width: margin.left } : { right: 0, width: margin.right }),
        }}
      >
        <AnimatePresence custom={{ drift, reducedMotion } satisfies LabelMotion} initial={false}>
          {ticks.map((tick, index) => {
            // Cascade in the direction of travel: bottom-up while labels
            // rise, top-down while they fall.
            const cascadeIndex = drift < 0 ? index : ticks.length - 1 - index;
            return (
              <m.div
                animate="visible"
                className="absolute flex h-0 items-center"
                custom={{ drift, reducedMotion } satisfies LabelMotion}
                exit="exit"
                initial="hidden"
                key={tick.value}
                style={{
                  top: tick.y + Y_AXIS_LABEL_CLIP_BLEED_PX,
                  ...(isLeft
                    ? {
                        right: 0,
                        justifyContent: "flex-end",
                        paddingRight: Y_AXIS_LABEL_GAP_PX,
                      }
                    : {
                        left: 0,
                        justifyContent: "flex-start",
                        paddingLeft: Y_AXIS_LABEL_GAP_PX,
                      }),
                }}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : {
                        delay: cascadeIndex * Y_AXIS_LABEL_STAGGER_S,
                        duration: Y_AXIS_LABEL_ENTER_S,
                        ease: Y_AXIS_LABEL_EASE_OUT,
                      }
                }
                variants={labelVariants}
              >
                <span
                  className="chart-tick whitespace-nowrap"
                  style={tick.labelColor ? { color: tick.labelColor } : undefined}
                >
                  {tick.label}
                </span>
              </m.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>,
    container,
  );
});

YAxis.displayName = "YAxis";
