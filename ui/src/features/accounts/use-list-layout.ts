import { type RefObject, useLayoutEffect, useState } from "react";
import { useIsMobile } from "@/hooks/use-media-query";

export type ListLayout = "cards" | "table";

/**
 * Narrowest list container that keeps the accounts table: the `md` breakpoint, as the spec
 * asks. Between this and FULL_TABLE_WIDTH the table hides its low-priority columns.
 */
export const TABLE_MIN_WIDTH = 768;

/**
 * Narrowest list container that shows every column without a sideways scroll (about 1,100 px
 * of columns in English). The columns are hidden with a container query on the list, so this
 * value is repeated in their `@[1100px]/accounts` class names.
 */
export const FULL_TABLE_WIDTH = 1100;

/**
 * Once the list shows cards, it goes back to the table only TABLE_MIN_WIDTH + this wide, so a
 * width that hovers at the threshold (the sidebar animating, a scrollbar appearing) does not
 * flip the layout back and forth.
 */
export const LAYOUT_HYSTERESIS = 24;

/** The layout for a measured list width, given the layout shown before it. */
export function nextListLayout(previous: ListLayout | null, width: number): ListLayout {
  if (previous === "cards") return width >= TABLE_MIN_WIDTH + LAYOUT_HYSTERESIS ? "table" : "cards";
  return width < TABLE_MIN_WIDTH ? "cards" : "table";
}

/**
 * Cards or table from the width of the list container, not the viewport: with the sidebar open,
 * a 1280 px window leaves less than 1,000 px for the list. Before the first measure, or where
 * layout has no size (jsdom), it falls back to the viewport rule (cards under `md`).
 */
export function useListLayout(ref: RefObject<HTMLElement | null>): ListLayout {
  const isMobile = useIsMobile();
  const [measured, setMeasured] = useState<ListLayout | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number) => {
      if (width <= 0) return;
      setMeasured((previous) => nextListLayout(previous, width));
    };
    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return measured ?? (isMobile ? "cards" : "table");
}
