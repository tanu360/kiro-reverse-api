import type { JSX } from "react";
import { useTheme } from "@/components/layout/theme-provider";

/**
 * The Kiro Proxy ghost, in the page's theme. The dark theme shows the original (white ghost, black
 * eyes and gap); the light theme shows public/icon-light.webp, the same mark with only its neutral
 * tones swapped (dark ghost, light eyes and gap) and the rainbow edge unchanged. Decorative: the
 * app name always sits next to it.
 */
export function AppIcon({ size, className }: { size: number; className?: string }): JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <img
      alt=""
      className={className}
      height={size}
      src={resolvedTheme === "dark" ? "/admin/icon.webp" : "/admin/icon-light.webp"}
      width={size}
    />
  );
}
