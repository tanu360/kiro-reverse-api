import { createContext, createElement, type ReactNode, useContext } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";

/**
 * Whether the controls in a card header's actions show compact: always on a phone, and from sm up
 * when with their labels they would not fit beside the title (CardAction measures it); the
 * actions never drop under the heading. A
 * Button with an icon keeps only the icon (its label stays its accessible name); a
 * SegmentedPicker becomes one button that steps through its options.
 */
export const CompactActionsContext = createContext(false);

export function useCompactActions(): boolean {
  return useContext(CompactActionsContext);
}

/**
 * Controls under it keep their labels in a compact header: a popup's (a dialog, menu, popover,
 * tooltip or select popup: React context crosses the portal, but the popup is not in the header),
 * and an action whose label is the point of it (a picker's current option, a "View all" link).
 */
export function KeepLabels({ children }: { children: ReactNode }): ReactNode {
  return createElement(CompactActionsContext.Provider, { value: false }, children);
}

/**
 * Controls under it show compact on a phone (below sm), as every card header's actions do there,
 * so like buttons look alike across the app: a page header's actions, a sheet's action row.
 */
export function CompactOnPhone({ children }: { children: ReactNode }): ReactNode {
  const phone = useMediaQuery("max-sm");
  return createElement(CompactActionsContext.Provider, { value: phone }, children);
}
