"use client";

import { Meter as MeterPrimitive } from "@base-ui/react/meter";
import type React from "react";
import { cn } from "@/lib/utils";

export function Meter({
  className,
  children,
  ...props
}: MeterPrimitive.Root.Props): React.ReactElement {
  return (
    <MeterPrimitive.Root
      className={cn("flex w-full flex-col gap-2", className)}
      {...props}
    >
      {children ? (
        children
      ) : (
        <MeterTrack>
          <MeterIndicator />
        </MeterTrack>
      )}
    </MeterPrimitive.Root>
  );
}

export function MeterLabel({
  className,
  ...props
}: MeterPrimitive.Label.Props): React.ReactElement {
  return (
    <MeterPrimitive.Label
      className={cn("font-medium text-foreground text-sm", className)}
      data-slot="meter-label"
      {...props}
    />
  );
}

export function MeterTrack({
  className,
  ...props
}: MeterPrimitive.Track.Props): React.ReactElement {
  return (
    <MeterPrimitive.Track
      // A thin rounded bar: 4 px, fully rounded, on the input tone.
      className={cn("block h-1 w-full overflow-hidden rounded-full bg-input", className)}
      data-slot="meter-track"
      {...props}
    />
  );
}

/** The fill in the primary purple, or a status pill colour (index.css --pill-*) as it fills up. */
const METER_TONE = {
  default: "bg-primary",
  warning: "bg-(--pill-warning)",
  destructive: "bg-(--pill-error)",
} as const;

export type MeterTone = keyof typeof METER_TONE;

export function MeterIndicator({
  className,
  tone = "default",
  ...props
}: MeterPrimitive.Indicator.Props & { tone?: MeterTone }): React.ReactElement {
  return (
    <MeterPrimitive.Indicator
      className={cn("rounded-full transition-all duration-500", METER_TONE[tone], className)}
      data-slot="meter-indicator"
      {...props}
    />
  );
}

export function MeterValue({
  className,
  ...props
}: MeterPrimitive.Value.Props): React.ReactElement {
  return (
    <MeterPrimitive.Value
      className={cn("text-foreground text-sm tabular-nums", className)}
      data-slot="meter-value"
      {...props}
    />
  );
}

export { MeterPrimitive };
