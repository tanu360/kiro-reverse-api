"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface ChartLegendHoverContextValue {
  hoveredIndex: number | null;
  setHoveredIndex: (index: number | null) => void;
}

const ChartLegendHoverContext =
  createContext<ChartLegendHoverContextValue | null>(null);

/**
 * Shares the hovered series index between a `Legend` and the chart series it
 * describes (series dim and marker fade read it). Indices follow the order the
 * series are declared in the chart. Controlled with `hoveredIndex` +
 * `onHoverChange`, or uncontrolled when `hoveredIndex` is omitted.
 */
export function ChartLegendHoverProvider({
  hoveredIndex: controlledIndex,
  onHoverChange,
  children,
}: {
  hoveredIndex?: number | null;
  onHoverChange?: (index: number | null) => void;
  children: ReactNode;
}) {
  const [internalIndex, setInternalIndex] = useState<number | null>(null);
  const controlled = controlledIndex !== undefined;
  const hoveredIndex = controlled ? controlledIndex : internalIndex;
  const setHoveredIndex = useCallback(
    (index: number | null) => {
      if (!controlled) {
        setInternalIndex(index);
      }
      onHoverChange?.(index);
    },
    [controlled, onHoverChange]
  );
  const value = useMemo(
    () => ({ hoveredIndex, setHoveredIndex }),
    [hoveredIndex, setHoveredIndex]
  );

  return (
    <ChartLegendHoverContext.Provider value={value}>
      {children}
    </ChartLegendHoverContext.Provider>
  );
}

/** The shared legend hover, or `null` outside a `ChartLegendHoverProvider`. */
export function useOptionalChartLegendHover(): ChartLegendHoverContextValue | null {
  return useContext(ChartLegendHoverContext);
}

export function useChartLegendHover(): ChartLegendHoverContextValue {
  const context = useContext(ChartLegendHoverContext);
  return (
    context ?? {
      hoveredIndex: null,
      setHoveredIndex: () => {
        /* noop outside ChartLegendHoverProvider */
      },
    }
  );
}
