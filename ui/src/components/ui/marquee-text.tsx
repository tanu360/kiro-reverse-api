import {
  Children,
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

/**
 * A one-line label for a popup row. A label that fits shows as is; one wider than the row ends in
 * an ellipsis, and while its row is highlighted (pointer or keyboard) it slides across to show
 * the rest and back. With reduced motion it wraps onto more lines instead. The look lives in
 * index.css (`.marquee-text`); this measures how far the label has to travel.
 */
function MarqueeText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  const outerRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    // The clipped box's scroll width is the label's full width (an inline span has none).
    const measure = () => {
      setDistance(Math.max(0, Math.ceil(outer.scrollWidth - outer.clientWidth)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, []);

  // About 40 px a second, plus the pauses at each end (30 % of the cycle).
  const style = {
    "--marquee-distance": `${distance}px`,
    "--marquee-duration": `${(1.2 + distance / 40).toFixed(2)}s`,
  } as CSSProperties;

  return (
    <span
      className={cn("marquee-text", className)}
      data-overflow={distance > 0 || undefined}
      ref={outerRef}
      style={style}
    >
      <span>{children}</span>
    </span>
  );
}

/** Wraps the bare text children of a popup row in MarqueeText, leaving icons and nodes as they are. */
export function withMarqueeText(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === "string" || typeof child === "number" ? (
      <MarqueeText>{child}</MarqueeText>
    ) : (
      child
    ),
  );
}
