import { type RefObject, useLayoutEffect, useState } from "react";
import { useIsMobile } from "@/hooks/use-media-query";

export type ListLayout = "cards" | "table";

/**
 * Narrowest list container that shows the full accounts table without a sideways scroll
 * (about 1,100 px of columns in English). Narrower containers get cards.
 */
export const TABLE_MIN_WIDTH = 1100;

/**
 * Cards or table from the width of the list container, not the viewport: with the sidebar open,
 * a 1280 px window leaves less than 1,000 px for the list. Before the first measure, or where
 * layout has no size (jsdom), it falls back to the viewport rule (cards under `md`).
 */
export function useListLayout(ref: RefObject<HTMLElement | null>): ListLayout {
  const isMobile = useIsMobile();
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  if (width <= 0) return isMobile ? "cards" : "table";
  return width < TABLE_MIN_WIDTH ? "cards" : "table";
}
