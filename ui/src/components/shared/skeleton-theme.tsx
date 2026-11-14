import type { JSX, ReactNode } from "react";
import { SkulletProvider } from "skullet/react";
import { useTheme } from "@/components/layout/theme-provider";

/**
 * The app's skeleton tokens (index.css --skeleton and --skeleton-highlight, which switch with the
 * theme), the md radius and the same soft breathing as components/ui/skeleton, so a measured
 * skullet skeleton sits beside a hand-drawn one without a seam.
 */
const SKELETON_COLORS = { base: "var(--skeleton)", highlight: "var(--skeleton-highlight)" };
export const SKELETON_THEME = {
  light: SKELETON_COLORS,
  dark: SKELETON_COLORS,
  radius: "var(--radius-md)",
  animation: "pulse",
  speed: "slow",
} as const;

/** Sets skullet up for the whole app, following the resolved light or dark theme. */
export function SkeletonThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <SkulletProvider mode={resolvedTheme} theme={SKELETON_THEME}>
      {children}
    </SkulletProvider>
  );
}
