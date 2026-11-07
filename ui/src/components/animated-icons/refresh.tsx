import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import { forwardRef } from "react";
import { type AnimatedIconProps, useIconAnimation } from "@/lib/use-icon-animation";
import { cn } from "@/lib/utils";

interface RefreshIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

type RefreshIconProps = AnimatedIconProps;

// rewinds slightly, then whips a full revolution; 360 ≡ 0 so the reset is
// invisible. Exit eases briefly instead of snapping mid-spin.
const svgVariants: Variants = {
  normal: { rotate: 0, transition: { duration: 0.15, ease: "easeOut" } },
  animate: {
    rotate: [0, -25, 360],
    transition: { duration: 0.9, times: [0, 0.2, 1], ease: ["easeIn", "easeOut"] },
  },
};

const RefreshIcon = forwardRef<RefreshIconHandle, RefreshIconProps>(
  ({ className, size = 28, playOnMount = false, ...props }, ref) => {
    const controls = useAnimation();
    const svgRef = useIconAnimation({
      controls,
      loops: false,
      playOnMount,
      ref,
    });

    return (
      <motion.svg
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
        variants={svgVariants}
        animate={controls}
        initial="normal"
      >
        <path
          d="M20.0092 2V5.13219C20.0092 5.42605 19.6418 5.55908 19.4537 5.33333C17.6226 3.2875 14.9617 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </motion.svg>
    );
  },
);

RefreshIcon.displayName = "RefreshIcon";

export { RefreshIcon };
