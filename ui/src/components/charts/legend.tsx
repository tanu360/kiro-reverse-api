"use client";

// Vendored from bklit @bklit/legend (ui.bklit.com/r/legend.json), folded into one module and
// restyled on the Kiro tokens: meta-size muted labels, tabular values, a chart-grid progress
// track. Hover is shared with the chart through chart-legend-hover.tsx, so hovering an item
// dims the other series.

import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { intFmt } from "./chart-formatters";
import { useOptionalChartLegendHover } from "./chart-legend-hover";

export type LegendMarkerVariant = "dot" | "line" | "dashed";

export interface LegendItemData {
  /** Display label. */
  label: string;
  /** Value shown by `LegendValue`. Omit for marker + label chips. */
  value?: number;
  /** Upper bound for `LegendProgress` and the percentage. */
  maxValue?: number;
  /** Series colour (a token var, e.g. `var(--chart-1)`). */
  color: string;
  /** Marker shape for this item. Default: `"dot"`. */
  marker?: LegendMarkerVariant;
  /** React key. Default: `label`. */
  key?: string;
}

export interface LegendContextValue {
  items: LegendItemData[];
  hoveredIndex: number | null;
  setHoveredIndex: (index: number | null) => void;
}

export interface LegendItemContextValue {
  item: LegendItemData;
  index: number;
  /** This item is hovered. */
  isHovered: boolean;
  /** Another item is hovered. */
  isFaded: boolean;
  /** value / maxValue × 100, or 0 without both. */
  percentage: number;
}

const LegendContext = createContext<LegendContextValue | null>(null);
const LegendItemContext = createContext<LegendItemContextValue | null>(null);

export function useLegend(): LegendContextValue {
  const context = useContext(LegendContext);
  if (!context) {
    throw new Error("useLegend must be used within a <Legend> component.");
  }
  return context;
}

export function useLegendItem(): LegendItemContextValue {
  const context = useContext(LegendItemContext);
  if (!context) {
    throw new Error("useLegendItem must be used within a <Legend> item.");
  }
  return context;
}

export interface LegendProps {
  /** One entry per series, in the order the series are declared in the chart. */
  items: LegendItemData[];
  /** Controlled hovered index. Default: the surrounding `ChartLegendHoverProvider`, else internal. */
  hoveredIndex?: number | null;
  onHoverChange?: (index: number | null) => void;
  /** `"horizontal"`: wrapping chips (card headers, under a chart). `"vertical"`: a stacked list. */
  orientation?: "horizontal" | "vertical";
  /** Layout classes only. */
  className?: string;
  "aria-label"?: string;
  /**
   * One `LegendItem` used as the template for every item. Default: marker,
   * label and (when the item has one) value.
   */
  children?: ReactElement;
}

const defaultTemplate = (
  <LegendItem>
    <LegendMarker />
    <LegendLabel />
    <LegendValue />
  </LegendItem>
);

/** Series key for a chart: marker, label and optional value per item, hover-linked to the series. */
export function Legend({
  items,
  hoveredIndex: controlledIndex,
  onHoverChange,
  orientation = "horizontal",
  className,
  "aria-label": ariaLabel,
  children,
}: LegendProps) {
  const shared = useOptionalChartLegendHover();
  const [internalIndex, setInternalIndex] = useState<number | null>(null);

  let hoveredIndex: number | null;
  let setHoveredIndex: (index: number | null) => void;
  if (controlledIndex !== undefined) {
    hoveredIndex = controlledIndex;
    setHoveredIndex = (index) => onHoverChange?.(index);
  } else if (shared) {
    hoveredIndex = shared.hoveredIndex;
    setHoveredIndex = (index) => {
      shared.setHoveredIndex(index);
      onHoverChange?.(index);
    };
  } else {
    hoveredIndex = internalIndex;
    setHoveredIndex = (index) => {
      setInternalIndex(index);
      onHoverChange?.(index);
    };
  }

  const template = isValidElement(children) ? children : defaultTemplate;

  return (
    <LegendContext.Provider value={{ items, hoveredIndex, setHoveredIndex }}>
      <ul
        aria-label={ariaLabel}
        className={cn(
          "m-0 flex list-none p-0",
          orientation === "horizontal"
            ? "flex-wrap items-center gap-x-4 gap-y-1"
            : "flex-col gap-1",
          className
        )}
        data-slot="chart-legend"
      >
        {items.map((item, index) => {
          const percentage =
            item.maxValue && item.value !== undefined
              ? (item.value / item.maxValue) * 100
              : 0;
          return (
            <LegendItemContext.Provider
              key={item.key ?? item.label}
              value={{
                item,
                index,
                isHovered: hoveredIndex === index,
                isFaded: hoveredIndex !== null && hoveredIndex !== index,
                percentage,
              }}
            >
              {cloneElement(template)}
            </LegendItemContext.Provider>
          );
        })}
      </ul>
    </LegendContext.Provider>
  );
}

Legend.displayName = "Legend";

export interface LegendItemProps {
  /** Layout classes only (e.g. `flex-col items-stretch` for a row with a progress bar). */
  className?: string;
  /** LegendMarker, LegendLabel, LegendValue, LegendProgress. */
  children: ReactNode;
}

/** One legend entry; hovering it highlights its series and fades the rest. */
export function LegendItem({ className, children }: LegendItemProps) {
  const { setHoveredIndex } = useLegend();
  const { index, isHovered, isFaded } = useLegendItem();

  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-1.5 transition-opacity duration-150 ease-out motion-reduce:transition-none",
        isFaded && "opacity-50",
        className
      )}
      data-faded={isFaded ? "" : undefined}
      data-hovered={isHovered ? "" : undefined}
      data-slot="chart-legend-item"
      onPointerEnter={() => setHoveredIndex(index)}
      onPointerLeave={() => setHoveredIndex(null)}
    >
      {children}
    </li>
  );
}

LegendItem.displayName = "LegendItem";

export interface LegendMarkerProps {
  /** Marker shape. Default: the item's `marker`, else `"dot"`. */
  variant?: LegendMarkerVariant;
  className?: string;
}

/** Series swatch: a dot, a solid line or a dashed line (comparison series). */
export function LegendMarker({ variant, className }: LegendMarkerProps) {
  const { item } = useLegendItem();
  const shape = variant ?? item.marker ?? "dot";

  if (shape === "dot") {
    // The colour is series data, so it stays an inline style.
    return (
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", className)}
        style={{ backgroundColor: item.color }}
      />
    );
  }

  const dashed = shape === "dashed";
  return (
    <svg
      aria-hidden
      className={cn("h-0.5 w-3.5 shrink-0 overflow-visible", className)}
      preserveAspectRatio="none"
      viewBox="0 0 14 2"
    >
      <line
        stroke={item.color}
        strokeDasharray={dashed ? "3 2.5" : undefined}
        strokeLinecap={dashed ? "butt" : "round"}
        strokeWidth={2}
        x1={dashed ? 0 : 1}
        x2={dashed ? 14 : 13}
        y1={1}
        y2={1}
      />
    </svg>
  );
}

LegendMarker.displayName = "LegendMarker";

export interface LegendLabelProps {
  className?: string;
}

/** The item label: meta size, muted, foreground while hovered. */
export function LegendLabel({ className }: LegendLabelProps) {
  const { item, isHovered } = useLegendItem();

  return (
    <span
      className={cn(
        "min-w-0 truncate text-meta text-muted-foreground transition-colors duration-150",
        isHovered && "text-foreground",
        className
      )}
    >
      {item.label}
    </span>
  );
}

LegendLabel.displayName = "LegendLabel";

export interface LegendValueProps {
  className?: string;
  /** Also show value / maxValue as a percentage. Default: false */
  showPercentage?: boolean;
  /** Default: the UI-language integer format. */
  formatValue?: (value: number) => string;
  /** Default: whole percent, e.g. "42%". */
  formatPercentage?: (percentage: number) => string;
}

/** The item value in tabular figures; renders nothing when the item has no value. */
export function LegendValue({
  className,
  showPercentage = false,
  formatValue = intFmt,
  formatPercentage = (p) => `${Math.round(p)}%`,
}: LegendValueProps) {
  const { item, percentage } = useLegendItem();
  if (item.value === undefined) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 font-medium text-foreground text-meta tabular-nums",
        className
      )}
    >
      <span>{formatValue(item.value)}</span>
      {showPercentage && item.maxValue ? (
        <span className="font-normal text-muted-foreground">
          {formatPercentage(percentage)}
        </span>
      ) : null}
    </span>
  );
}

LegendValue.displayName = "LegendValue";

export interface LegendProgressProps {
  /** Layout classes only. */
  className?: string;
}

/** A 4 px share bar (value / maxValue) on the chart-grid track. Decorative: pair it with LegendValue. */
export function LegendProgress({ className }: LegendProgressProps) {
  const { item, percentage } = useLegendItem();
  if (!item.maxValue || item.value === undefined) {
    return null;
  }
  const width = Math.min(100, Math.max(0, percentage));

  return (
    <span
      aria-hidden
      className={cn(
        "block h-1 w-full overflow-hidden rounded-full bg-chart-grid",
        className
      )}
    >
      <span
        className="block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${width}%`, backgroundColor: item.color }}
      />
    </span>
  );
}

LegendProgress.displayName = "LegendProgress";

export default Legend;
