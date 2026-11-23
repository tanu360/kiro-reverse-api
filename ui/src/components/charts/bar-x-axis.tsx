"use client";

import { m } from "motion/react";
import { memo, useMemo } from "react";
import { createPortal } from "react-dom";
import { useChart, useChartPortalContainer, useChartStable } from "./chart-context";
import {
  type ChartLabelCount,
  resolveResponsiveChartLabelCount,
} from "./responsive-chart-label-count";

interface BarXAxisProps {
  /** Width of the date ticker box for fade calculation; 0 (no date pill) keeps every label. Default: 50 */
  tickerHalfWidth?: number;
  /** Whether to show all labels or skip some for dense data. Default: false */
  showAllLabels?: boolean;
  /** Maximum number of labels to show. Supports responsive breakpoints. */
  maxLabels?: ChartLabelCount;
}

interface BarXAxisLabelProps {
  label: string;
  x: number;
  crosshairX: number | null;
  isHovering: boolean;
  tickerHalfWidth: number;
  /** The plot's left and right edge: a label centred on its bar shifts just enough to stay in. */
  bounds: readonly [number, number];
}

/** Centred on the bar, shifted inside `bounds` (as the time axis does with its labels). */
function labelShift(x: number, [min, max]: readonly [number, number]): string {
  return `translateX(clamp(${min - x}px, -50%, calc(${max - x}px - 100%)))`;
}

function BarXAxisLabel({
  label,
  x,
  crosshairX,
  isHovering,
  tickerHalfWidth,
  bounds,
}: BarXAxisLabelProps) {
  const fadeBuffer = 20;
  const fadeRadius = tickerHalfWidth + fadeBuffer;

  let opacity = 1;
  if (isHovering && crosshairX !== null && tickerHalfWidth > 0) {
    const distance = Math.abs(x - crosshairX);
    if (distance < tickerHalfWidth) {
      opacity = 0;
    } else if (distance < fadeRadius) {
      opacity = (distance - tickerHalfWidth) / fadeBuffer;
    }
  }

  // The time axis's tick type (mono, 11 px, the label colour), so the bar chart's times read like
  // the counts beside them; a label at either end stays over the plot instead of the padding.
  return (
    <div
      className="absolute whitespace-nowrap"
      style={{ left: x, bottom: 12, transform: labelShift(x, bounds) }}
    >
      <m.span
        animate={{ opacity }}
        className="chart-tick block"
        initial={{ opacity: 1 }}
        transition={{ duration: 0.4, ease: "easeInOut" }}
      >
        {label}
      </m.span>
    </div>
  );
}

export function BarXAxis(props: BarXAxisProps) {
  const { containerRef, barScale } = useChartStable();
  const container = useChartPortalContainer(containerRef);
  if (!container) {
    return null;
  }

  if (!barScale) {
    return null;
  }

  return <BarXAxisInner {...props} container={container} />;
}

const BarXAxisInner = memo(function BarXAxisInner({
  tickerHalfWidth = 50,
  showAllLabels = false,
  maxLabels = 12,
  container,
}: BarXAxisProps & { container: HTMLDivElement }) {
  const { margin, tooltipData, barScale, bandWidth, barXAccessor, data, dateLabels, width } =
    useChart();
  const bounds = useMemo<readonly [number, number]>(
    () => [margin.left, Math.max(margin.left, width - margin.right)],
    [margin.left, margin.right, width],
  );

  const resolvedMaxLabels = useMemo(
    () => resolveResponsiveChartLabelCount(maxLabels, width, 12),
    [maxLabels, width],
  );

  // Generate labels for each bar
  const labelsToShow = useMemo(() => {
    if (!(barScale && bandWidth && barXAccessor)) {
      return [];
    }

    const allLabels = data.map((d, index) => {
      const label = dateLabels[index] ?? barXAccessor(d);
      const bandX = barScale(barXAccessor(d)) ?? 0;
      // Center the label under the bar group
      const x = bandX + bandWidth / 2 + margin.left;
      return { label, x };
    });

    if (showAllLabels) {
      return allLabels;
    }

    // Skip labels to stay within maxLabels, and further on a narrow plot (a chart in a phone's
    // sheet) so no two labels touch. Two shown labels need 1.5 widths of the longest label plus
    // a 12 px gap between their bars: an end label is shifted inside the plot, so it can reach
    // a whole width toward its neighbour. Ticks are 11 px mono, about 0.6 em a character.
    const longest = Math.max(...allLabels.map((item) => item.label.length));
    const minSpacing = longest * 11 * 0.6 * 1.5 + 12;
    const pitch = allLabels.length > 1 ? allLabels[1].x - allLabels[0].x : Number.POSITIVE_INFINITY;
    const fitStep = pitch > 0 ? Math.ceil(minSpacing / pitch) : 1;
    const countStep =
      allLabels.length <= resolvedMaxLabels
        ? 1
        : Math.ceil(allLabels.length / Math.max(1, resolvedMaxLabels));
    const step = Math.max(countStep, fitStep);
    return step <= 1 ? allLabels : allLabels.filter((_, i) => i % step === 0);
  }, [
    barScale,
    bandWidth,
    barXAccessor,
    data,
    dateLabels,
    margin.left,
    showAllLabels,
    resolvedMaxLabels,
  ]);

  const isHovering = tooltipData !== null;
  const crosshairX = tooltipData ? tooltipData.x + margin.left : null;

  return createPortal(
    <div className="pointer-events-none absolute inset-0">
      {labelsToShow.map((item) => (
        <BarXAxisLabel
          crosshairX={crosshairX}
          isHovering={isHovering}
          key={`${item.label}-${item.x}`}
          label={item.label}
          bounds={bounds}
          tickerHalfWidth={tickerHalfWidth}
          x={item.x}
        />
      ))}
    </div>,
    container,
  );
});

BarXAxis.displayName = "BarXAxis";
