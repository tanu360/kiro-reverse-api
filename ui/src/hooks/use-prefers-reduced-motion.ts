import { useMediaQuery } from "@/hooks/use-media-query";

/** True while the viewer asks for reduced motion: animations and transitions should not run. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
