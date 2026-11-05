import { type RefObject, useEffect, useState } from "react";

type WidthListener = (width: number) => void;

// One ResizeObserver for every element on the page that reports its width.
let sharedObserver: ResizeObserver | null = null;
const widthListeners = new WeakMap<Element, WidthListener>();

/**
 * Calls `listener` with the element's content-box width now and whenever it changes, through one
 * shared ResizeObserver. Returns the unsubscribe function. Without ResizeObserver (old browsers,
 * some test setups) it reports the current width once.
 */
export function observeWidth(element: Element, listener: WidthListener): () => void {
  if (typeof ResizeObserver === "undefined") {
    listener(element.getBoundingClientRect().width);
    return () => undefined;
  }
  sharedObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      widthListeners.get(entry.target)?.(entry.contentRect.width);
    }
  });
  widthListeners.set(element, listener);
  sharedObserver.observe(element);
  return () => {
    widthListeners.delete(element);
    sharedObserver?.unobserve(element);
  };
}

/**
 * The element's content-box width in px, rounded to half a pixel so sub-pixel jitter does not
 * re-render. 0 until the first measurement. Prefer container queries for layout; use this only
 * when script needs the number (a chart's drawing width).
 */
export function useElementWidth(ref: RefObject<Element | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeWidth(element, (next) => setWidth(Math.round(next * 2) / 2));
  }, [ref]);
  return width;
}
