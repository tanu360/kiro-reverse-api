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
  /** Width of the date ticker box for fade calculation. Default: 50 */
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
  if (isHovering && crosshairX !== null) {
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
  const { margin, tooltipData, barScale, bandWidth, barXAccessor, data, width } = useChart();
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

    const allLabels = data.map((d) => {
      const label = barXAccessor(d);
      const bandX = barScale(label) ?? 0;
      // Center the label under the bar group
      const x = bandX + bandWidth / 2 + margin.left;
      return { label, x };
    });

    // If showAllLabels is true or we have fewer than maxLabels, show all
    if (showAllLabels || allLabels.length <= resolvedMaxLabels) {
      return allLabels;
    }

    // Otherwise, skip some labels to avoid crowding
    const step = Math.ceil(allLabels.length / Math.max(1, resolvedMaxLabels));
    return allLabels.filter((_, i) => i % step === 0);
  }, [barScale, bandWidth, barXAccessor, data, margin.left, showAllLabels, resolvedMaxLabels]);

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
