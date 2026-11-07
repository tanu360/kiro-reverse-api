import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import { forwardRef } from "react";
import { type AnimatedIconProps, useIconAnimation } from "@/lib/use-icon-animation";
import { cn } from "@/lib/utils";

interface PlusSignIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

type PlusSignIconProps = AnimatedIconProps;

// a mark stamping into place: the combined glyph hands off to two
// hand-drawn strokes that each overshoot long, pinch short, and settle
const plusBaseVariants: Variants = {
  normal: { visibility: "visible", transition: { duration: 0.2, delay: 0.05 } },
  animate: { visibility: "hidden", transition: { duration: 0.08 } },
};

const stemVariants: Variants = {
  normal: { d: "M12 4V20", visibility: "hidden", transition: { duration: 0.15 } },
  animate: {
    d: ["M12 4V20", "M12 2.6V21.4", "M12 4.6V19.4", "M12 4V20"],
    visibility: "visible",
    transition: {
      d: { duration: 0.5, ease: "easeInOut", times: [0, 0.32, 0.68, 1] },
    },
  },
};

const armVariants: Variants = {
  normal: { d: "M20 12H4", visibility: "hidden", transition: { duration: 0.15 } },
  animate: {
    d: ["M20 12H4", "M21.4 12H2.6", "M19.4 12H4.6", "M20 12H4"],
    visibility: "visible",
    transition: {
      d: { duration: 0.5, ease: "easeInOut", times: [0, 0.32, 0.68, 1], delay: 0.05 },
    },
  },
};
const generatedGeometryVariants: Variants = {
  normal: { visibility: "hidden", transition: { duration: 0.08 } },
  animate: { visibility: "visible", transition: { duration: 0.08 } },
};

const PlusSignIcon = forwardRef<PlusSignIconHandle, PlusSignIconProps>(
  ({ className, size = 28, playOnMount = false, ...props }, ref) => {
    const controls = useAnimation();
    const svgRef = useIconAnimation({
      controls,
      loops: false,
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
        <motion.path
          d="M12 4V20M20 12H4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          variants={plusBaseVariants}
          animate={controls}
          initial="normal"
        />
        <motion.g variants={generatedGeometryVariants} animate={controls} initial="normal">
          <motion.path
            d="M12 4V20"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            variants={stemVariants}
            animate={controls}
            initial="normal"
          />
          <motion.path
            d="M20 12H4"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            variants={armVariants}
            animate={controls}
            initial="normal"
          />
        </motion.g>
      </svg>
    );
  },
);

PlusSignIcon.displayName = "PlusSignIcon";

export { PlusSignIcon };
