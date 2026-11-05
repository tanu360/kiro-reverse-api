"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import * as React from "react";
import { cn } from "@/lib/utils";

export type SegmentedControlSize = "default" | "lg" | "sm" | "icon";

/**
 * Item heights; the track adds its 1 px padding and 1 px border on each side (+4 px), so with a
 * mouse each size is the height of the matching button (phone / sm and up / coarse pointer):
 *   sm       items 28 / 24 / 36   track 32 / 28 / 40   (the sm and icon-sm buttons beside it)
 *   default  items 32 / 28 / 36   track 36 / 32 / 40
 *   lg       items 40 / 36 / 40   track 44 / 40 / 44
 *   icon     square default items, for icon-only segments (the sign-in theme toggle)
 * On a coarse pointer no strip is under 40 px, whatever its size: a filter, a range or a tab is a
 * finger's tap, so sm grows to the default's touch height there. A real height, not an ::after
 * hit box: content after a tab list would paint over an overflowing box. pointer-coarse sorts
 * after the sm: sizes, so it wins on touch tablets too.
 */
export const segmentedControlItemSizeClassNames: Record<
  SegmentedControlSize,
  string
> = {
  default: "h-8 px-[calc(--spacing(2.5)-1px)] sm:h-7 pointer-coarse:h-9",
  icon: "size-8 p-0 sm:size-7 pointer-coarse:size-9",
  lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9 pointer-coarse:h-10",
  sm: "h-7 px-[calc(--spacing(2)-1px)] sm:h-6 pointer-coarse:h-9",
};

/**
 * Deprecated: each size in segmentedControlItemSizeClassNames now carries its own coarse-pointer
 * height. This is the default size's (a 40 px track), kept for callers that still add it.
 */
export const segmentedControlItemTouchClassName = "pointer-coarse:h-9";

export const segmentedControlItemLayoutClassName =
  "gap-1.5 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0";

/**
 * The sign-in theme toggle is the segmented control: a pill frame in the field hairline, 1 px
 * inside it, and a round highlight in the neutral button's hover tint (index.css
 * --neutral-button-hover) with no shadow, the same tint a selected tab takes.
 */
export const segmentedControlIndicatorSurfaceClassName =
  "rounded-full bg-(--neutral-button-hover)";

/** The frame round the segments (and the default tabs list). */
export const segmentedControlTrackClassName =
  "relative z-0 flex w-fit items-center justify-center gap-0 rounded-full border border-field-border bg-transparent p-px";

/** `field`: the track takes the field fill, to sit among inputs and selects in a toolbar. */
export type SegmentedControlSurface = "none" | "field";

const segmentedControlSurfaceClassNames: Record<SegmentedControlSurface, string> = {
  field: "bg-field",
  none: "",
};

const SegmentedControlContext: React.Context<SegmentedControlSize> =
  React.createContext<SegmentedControlSize>("default");

/**
 * A row of mutually exclusive choices in a pill (the sign-in theme toggle). Items mark the chosen
 * one with data-checked, aria-current="page" or data-pressed, and a sliding indicator follows it.
 *
 * As a radio group (coss p-radio-group-7), for a value with keyboard arrows:
 *   <SegmentedControl aria-label="Range" render={<RadioGroupPrimitive value={range} onValueChange={setRange} />} size="sm">
 *     <SegmentedControlItem render={<RadioPrimitive.Root value="1h" />}>1h</SegmentedControlItem>
 *     <SegmentedControlItem render={<RadioPrimitive.Root value="24h" />}>24h</SegmentedControlItem>
 *   </SegmentedControl>
 * (RadioGroupPrimitive and RadioPrimitive from components/ui/radio-group.tsx.)
 */
export function SegmentedControl({
  className,
  children,
  render,
  size = "default",
  surface = "none",
  ...props
}: useRender.ComponentProps<"div"> & {
  size?: SegmentedControlSize;
  surface?: SegmentedControlSurface;
}): React.ReactElement {
  const defaultProps = {
    children: (
      <>
        {children}
        <SegmentedControlIndicator />
      </>
    ),
    className: cn(
      segmentedControlTrackClassName,
      segmentedControlSurfaceClassNames[surface],
      className,
    ),
    "data-size": size,
    "data-slot": "segmented-control",
  };

  const element = useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });

  return (
    <SegmentedControlContext.Provider value={size}>
      {element}
    </SegmentedControlContext.Provider>
  );
}

export function SegmentedControlItem({
  className,
  render,
  size,
  ...props
}: useRender.ComponentProps<"button"> & {
  size?: SegmentedControlSize;
}): React.ReactElement {
  const contextSize = React.useContext(SegmentedControlContext);
  const resolvedSize = size ?? contextSize;

  const defaultProps = {
    className: cn(
      "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-full border border-transparent font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-outline-inner disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64",
      // The chosen item's own fill, until the sliding indicator has measured it.
      "data-checked:bg-(--neutral-button-hover) data-checked:text-foreground",
      "aria-[current=page]:bg-(--neutral-button-hover) aria-[current=page]:text-foreground",
      "data-pressed:bg-(--neutral-button-hover) data-pressed:text-foreground",
      "[:has(>[data-slot=segmented-control-indicator]:not([hidden]))>&]:bg-transparent!",
      segmentedControlItemLayoutClassName,
      segmentedControlItemSizeClassNames[resolvedSize],
      className,
    ),
    "data-size": resolvedSize,
    "data-slot": "segmented-control-item",
    ...(render ? {} : { type: "button" as const }),
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

const activeItemSelector =
  ':scope > [data-checked], :scope > [aria-current="page"], :scope > [data-pressed]';

const observedAttributes: string[] = [
  "data-checked",
  "aria-current",
  "data-pressed",
];

const MAX_LAYOUT_ROUNDING_ERROR = 2;

interface ActiveItemRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

function isSameRect(
  a: ActiveItemRect | null,
  b: ActiveItemRect | null,
): boolean {
  return (
    a?.left === b?.left &&
    a?.top === b?.top &&
    a?.width === b?.width &&
    a?.height === b?.height
  );
}

function getCssSize(element: HTMLElement): { height: number; width: number } {
  const style = getComputedStyle(element);
  const width = Number.parseFloat(style.width) || 0;
  const height = Number.parseFloat(style.height) || 0;
  if (
    Math.round(width) !== element.offsetWidth ||
    Math.round(height) !== element.offsetHeight
  ) {
    return { height: element.offsetHeight, width: element.offsetWidth };
  }
  return { height, width };
}

function measureItem(item: HTMLElement, root: HTMLElement): ActiveItemRect {
  const { width, height } = getCssSize(item);
  const rootSize = getCssSize(root);
  const itemRect = item.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const scaleX = rootSize.width > 0 ? rootRect.width / rootSize.width : 1;
  const scaleY = rootSize.height > 0 ? rootRect.height / rootSize.height : 1;

  const rectLeft =
    (itemRect.left - rootRect.left) / scaleX -
    root.clientLeft +
    root.scrollLeft;
  const rectTop =
    (itemRect.top - rootRect.top) / scaleY - root.clientTop + root.scrollTop;

  const isUndistorted =
    Math.abs(rectLeft - item.offsetLeft) <= MAX_LAYOUT_ROUNDING_ERROR &&
    Math.abs(rectTop - item.offsetTop) <= MAX_LAYOUT_ROUNDING_ERROR;

  return {
    height,
    left: isUndistorted ? rectLeft : item.offsetLeft,
    top: isUndistorted ? rectTop : item.offsetTop,
    width,
  };
}

function SegmentedControlIndicator(): React.ReactElement {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [rect, setRect] = React.useState<ActiveItemRect | null>(null);

  React.useLayoutEffect(() => {
    const root = ref.current?.parentElement;
    if (!root) {
      return;
    }

    const update = (): void => {
      const item = root.querySelector<HTMLElement>(activeItemSelector);
      const next = item ? measureItem(item, root) : null;
      setRect((previous) => (isSameRect(previous, next) ? previous : next));
    };

    update();

    const resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) {
        observeItems();
      }
      update();
    });
    const observeItems = (): void => {
      resizeObserver.disconnect();
      resizeObserver.observe(root);
      for (const child of root.children) {
        resizeObserver.observe(child);
        mutationObserver.observe(child, {
          attributeFilter: observedAttributes,
          attributes: true,
        });
      }
    };
    mutationObserver.observe(root, { childList: true });
    observeItems();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-0 left-0 -z-1 h-(--active-item-height) w-(--active-item-width) translate-x-(--active-item-left) translate-y-(--active-item-top) transition-[width,height,translate] duration-200 ease-in-out motion-reduce:transition-none",
        segmentedControlIndicatorSurfaceClassName,
      )}
      data-slot="segmented-control-indicator"
      hidden={!rect}
      ref={ref}
      style={
        {
          "--active-item-height": `${rect?.height ?? 0}px`,
          "--active-item-left": `${rect?.left ?? 0}px`,
          "--active-item-top": `${rect?.top ?? 0}px`,
          "--active-item-width": `${rect?.width ?? 0}px`,
        } as React.CSSProperties
      }
    />
  );
}
