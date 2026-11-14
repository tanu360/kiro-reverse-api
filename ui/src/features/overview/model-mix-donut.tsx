import { type JSX, useMemo } from "react";
import {
  chartCenterLabelClassName,
  chartCenterValueClassName,
} from "@/components/charts/chart-center-typography";
import { ChartStatFlow } from "@/components/charts/chart-stat-flow";
import { PieCenter } from "@/components/charts/pie-center";
import { PieChart } from "@/components/charts/pie-chart";
import { PieSlice } from "@/components/charts/pie-slice";

export interface RingSlice {
  label: string;
  value: number;
  maxValue: number;
  color: string;
}

const SHARE_FORMAT = { style: "percent", maximumFractionDigits: 1 } as const;

/**
 * Lazy-loaded Bklit donut for the model-mix card: one slice per model (largest first, from 12
 * o'clock, clockwise) and "Other", so the shares read as parts of one whole. The centre shows the
 * total, or the hovered model's share; `hoveredIndex` is shared with the table rows beside it.
 */
export default function ModelMixDonut({
  slices,
  centerLabel,
  shareLabel,
  fractionDigits,
  reducedMotion,
  hoveredIndex,
  onHoverChange,
  innerRadius = 0.78,
}: {
  slices: RingSlice[];
  centerLabel: string;
  shareLabel: string;
  fractionDigits: number;
  reducedMotion: boolean;
  hoveredIndex: number | null;
  onHoverChange: (index: number | null) => void;
  /**
   * The hole as a share of the radius. A smaller donut takes a smaller share, so its ring keeps
   * the dashboard ring's thickness (about 24 px) instead of thinning with the size.
   */
  innerRadius?: number;
}): JSX.Element {
  const data = useMemo(
    () => slices.map((slice) => ({ label: slice.label, value: slice.value, color: slice.color })),
    [slices],
  );
  const total = useMemo(() => slices.reduce((sum, slice) => sum + slice.value, 0), [slices]);
  return (
    <PieChart
      className="mx-auto max-w-56"
      cornerRadius={4}
      data={data}
      hoveredIndex={hoveredIndex}
      hoverOffset={6}
      // The ring is 22 % of the radius at any size (shadcn's donut is 25 %; 30 % read heavy with
      // the rounded, gapped slices), not a fixed 76 px hole that left a hairline ring in the
      // half-width card.
      innerRadius={innerRadius}
      onHoverChange={onHoverChange}
      padAngle={0.03}
    >
      {data.map((slice, index) => (
        <PieSlice
          animate={!reducedMotion}
          hoverEffect="translate"
          index={index}
          key={slice.label}
        />
      ))}
      <PieCenter
        defaultLabel={centerLabel}
        formatOptions={{ notation: "compact", maximumFractionDigits: fractionDigits }}
      >
        {({ value, isHovered }) => (
          <div className="flex flex-col items-center gap-0.5 text-center">
            {isHovered ? (
              <ChartStatFlow
                formatOptions={SHARE_FORMAT}
                label={shareLabel}
                labelClassName={chartCenterLabelClassName}
                value={total > 0 ? value / total : 0}
                valueClassName={chartCenterValueClassName}
              />
            ) : (
              <ChartStatFlow
                formatOptions={{ notation: "compact", maximumFractionDigits: fractionDigits }}
                label={centerLabel}
                labelClassName={chartCenterLabelClassName}
                value={value}
                valueClassName={chartCenterValueClassName}
              />
            )}
          </div>
        )}
      </PieCenter>
    </PieChart>
  );
}
