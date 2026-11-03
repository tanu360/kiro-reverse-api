import { useMediaQuery } from "@/hooks/use-media-query";

/** Charts pass this to their animate/animationDuration props. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
