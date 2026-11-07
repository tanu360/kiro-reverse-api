import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import { forwardRef } from "react";
import { type AnimatedIconProps, useIconAnimation } from "@/lib/use-icon-animation";
import { cn } from "@/lib/utils";

interface MoreVerticalIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

type MoreVerticalIconProps = AnimatedIconProps;

const dotVariants: Variants = {
  normal: { translateX: 0, scale: 1 },
  animate: (i: number) => ({
    translateX: [0, 1.5, -0.35, 0],
    scale: [1, 1.2, 0.95, 1],
    transition: { duration: 0.42, ease: "easeOut", delay: i * 0.08 },
  }),
};

const DOT_CENTERS = [6, 12, 18];

const MoreVerticalIcon = forwardRef<MoreVerticalIconHandle, MoreVerticalIconProps>(
  ({ className, size = 28, playOnMount = false, ...props }, ref) => {
    const controls = useAnimation();
    const svgRef = useIconAnimation({
      controls,
      playOnMount,
      ref,
    });

    return (
      <svg
        ref={svgRef}
        aria-hidden="true"
        className={cn(className)}
        {...props}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        overflow="visible"
      >
        {DOT_CENTERS.map((cy, index) => (
          <motion.circle
            key={cy}
            cx="12"
            cy={cy + 0.5}
            r="1"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.5"
            variants={dotVariants}
            custom={index}
            animate={controls}
            initial="normal"
            style={{ transformBox: "view-box", originX: 12 / 24, originY: (cy + 0.5) / 24 }}
          />
        ))}
      </svg>
    );
  },
);

MoreVerticalIcon.displayName = "MoreVerticalIcon";

export { MoreVerticalIcon };
