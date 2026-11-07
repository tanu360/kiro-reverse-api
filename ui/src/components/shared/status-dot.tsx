import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A small status disc: live/healthy (success), degraded (warning), failing (destructive), idle
 * (muted) or selected/dirty (primary). Each tone uses its status ramp's disc colour (>= 3:1).
 * `ping` adds a soft pulse for something live; it is skipped under reduced motion.
 */
const statusDotVariants = cva("relative inline-flex shrink-0 rounded-full", {
  defaultVariants: {
    size: "md",
    tone: "muted",
  },
  variants: {
    size: {
      sm: "size-1.5",
      md: "size-2",
    },
    tone: {
      success: "bg-success",
      warning: "bg-warning",
      destructive: "bg-destructive",
      muted: "bg-muted-foreground",
      primary: "bg-primary",
    },
  },
});

type StatusDotProps = Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof statusDotVariants> & {
    /** Pulse outward, for a live state. */
    ping?: boolean;
    /**
     * Names the state. With a label the dot is announced (role img) and shows the label in a
     * tooltip on hover; without one it is decorative.
     */
    label?: string;
  };

export function StatusDot({
  size,
  tone,
  ping = false,
  label,
  className,
  ...props
}: StatusDotProps): React.ReactElement {
  const classes = cn(statusDotVariants({ size, tone }), className);
  const pulse = ping ? (
    <span
      aria-hidden="true"
      className="absolute inset-0 rounded-full bg-inherit opacity-75 motion-safe:animate-ping"
    />
  ) : null;
  if (!label) {
    return (
      <span
        aria-hidden="true"
        className={classes}
        data-slot="status-dot"
        data-tone={tone ?? "muted"}
        {...props}
      >
        {pulse}
      </span>
    );
  }
  const dot = (
    <span
      aria-label={label}
      className={classes}
      data-slot="status-dot"
      data-tone={tone ?? "muted"}
      role="img"
      {...props}
    >
      {pulse}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
