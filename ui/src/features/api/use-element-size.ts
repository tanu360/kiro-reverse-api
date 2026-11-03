import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * The element's border-box width in px, kept current with a ResizeObserver. It is measured
 * before the first paint, so a layout chosen from it never flashes. 0 means not measured yet
 * (or not laid out, as in jsdom).
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(() => setWidth(element.getBoundingClientRect().width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * True while the element's content is wider than its box, so it scrolls sideways. Rechecked
 * when the element resizes or `content` changes.
 */
export function useHorizontalOverflow(
  ref: RefObject<HTMLElement | null>,
  content: unknown,
): boolean {
  const [overflows, setOverflows] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` changes the scroll width.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => setOverflows(element.scrollWidth > element.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, content]);
  return overflows;
}
