import type { JSX } from "react";
import { Ring } from "@/components/charts/ring";
import { RingCenter } from "@/components/charts/ring-center";
import { RingChart } from "@/components/charts/ring-chart";

export interface RingSlice {
  label: string;
  value: number;
  maxValue: number;
  color: string;
}

/** Lazy-loaded Bklit ring chart for the model-mix card. */
export default function ModelMixRing({
  slices,
  centerLabel,
  fractionDigits,
  reducedMotion,
}: {
  slices: RingSlice[];
  centerLabel: string;
  fractionDigits: number;
  reducedMotion: boolean;
}): JSX.Element {
  return (
    <RingChart
      baseInnerRadius={56}
      className="mx-auto max-w-56"
      data={slices}
      ringGap={5}
      strokeWidth={11}
    >
      {slices.map((slice, index) => (
        <Ring animate={!reducedMotion} color={slice.color} index={index} key={slice.label} />
      ))}
      <RingCenter
        defaultLabel={centerLabel}
        formatOptions={{ notation: "standard", maximumFractionDigits: fractionDigits }}
      />
    </RingChart>
  );
}
