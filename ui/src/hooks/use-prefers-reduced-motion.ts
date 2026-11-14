import { useMediaQuery } from "@/hooks/use-media-query";

/**
 * The one reduced-motion check in the app. CSS motion needs none: the global rule at the end of
 * index.css ends every animation and transition at once. Script-driven motion (Motion, the Web
 * Animations API, smooth scrolling, view transitions) asks here.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** True while the viewer asks for reduced motion, read once (event handlers, effects). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true
  );
}

/** True while the viewer asks for reduced motion: animations and transitions should not run. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}
