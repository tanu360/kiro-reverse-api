import { type JSX, useMemo } from "react";
import {
  chartCenterLabelClassName,
  chartCenterValueClassName,
} from "@/components/charts/chart-center-typography";
import { ChartStatFlow } from "@/components/charts/chart-stat-flow";
import { Ring } from "@/components/charts/ring";
import { RingCenter } from "@/components/charts/ring-center";
import { RingChart } from "@/components/charts/ring-chart";

export interface RingSlice {
  label: string;
  value: number;
  maxValue: number;
  color: string;
}

const SHARE_FORMAT = { style: "percent", maximumFractionDigits: 1 } as const;

/**
 * Lazy-loaded Bklit ring chart for the model-mix card. Slices come largest first; the largest
 * draws as the outermost ring, and every ring starts at 12 o'clock. The centre shows the total,
 * or the hovered model's share (its name is highlighted in the table beside it).
 * `hoveredIndex` is a slice index, shared with the table rows.
 */
export default function ModelMixRing({
  slices,
  centerLabel,
  shareLabel,
  fractionDigits,
  reducedMotion,
  hoveredIndex,
  onHoverChange,
}: {
  slices: RingSlice[];
  centerLabel: string;
  shareLabel: string;
  fractionDigits: number;
  reducedMotion: boolean;
  hoveredIndex: number | null;
  onHoverChange: (index: number | null) => void;
}): JSX.Element {
  // Ring 0 is the innermost, so the slices go in reversed.
  const rings = useMemo(() => [...slices].reverse(), [slices]);
  const last = rings.length - 1;
  return (
    <RingChart
      baseInnerRadius={60}
      className="mx-auto max-w-56"
      data={rings}
      endAngle={Math.PI * 2}
      hoveredIndex={hoveredIndex === null ? null : last - hoveredIndex}
      onHoverChange={(index) => onHoverChange(index === null ? null : last - index)}
      ringGap={4}
      startAngle={0}
      strokeWidth={12}
    >
      {rings.map((slice, index) => (
        <Ring animate={!reducedMotion} color={slice.color} index={index} key={slice.label} />
      ))}
      <RingCenter
        defaultLabel={centerLabel}
        formatOptions={{ notation: "compact", maximumFractionDigits: fractionDigits }}
      >
        {({ data }) => (
          <div className="flex flex-col items-center gap-0.5 text-center">
            <ChartStatFlow
              formatOptions={SHARE_FORMAT}
              label={shareLabel}
              labelClassName={chartCenterLabelClassName}
              value={data.maxValue > 0 ? data.value / data.maxValue : 0}
              valueClassName={chartCenterValueClassName}
            />
          </div>
        )}
      </RingCenter>
    </RingChart>
  );
}
