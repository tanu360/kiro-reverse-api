"use client";

import {
  animate as animateValue,
  domAnimation,
  LazyMotion,
  type MotionValue,
  m,
  useSpring,
} from "motion/react";
import {
  type CSSProperties,
  memo,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUiT } from "@/components/ui/messages";
import { prefersReducedMotion, usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { intlLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { DEFAULT_ANIMATION_EASING } from "./animation";
import { chartCssVars } from "./chart-context";
import {
  buildSparklineAreaPath,
  buildSparklineLinePath,
  computeSparklineDomain,
  computeSparklineLayout,
  describeSparkline,
  interpolateSparklineLayout,
  resolveSparklinePadding,
  resolveSparklineValues,
  type SparklineCurve,
  type SparklineDataKey,
  type SparklineLayout,
  type SparklinePadding,
  sparklineIndexAtX,
} from "./sparkline-geometry";

const DEFAULT_SPARKLINE_ANIMATION_DURATION_MS = 900;
/** Matches the main charts' data-change tween (`DEFAULT_Y_DOMAIN_TWEEN_MS`). */
const DEFAULT_SPARKLINE_DATA_TRANSITION_MS = 500;
const DATA_TRANSITION_EASE = [0.85, 0, 0.15, 1] as const;
/**
 * Same as the main charts' `SeriesHoverDim` / `HighlightSegment`. A class, not an inline
 * transition, so the global reduced-motion and theme-swap overrides win over it.
 */
const HOVER_FADE_CLASS = "[transition:opacity_400ms_ease-in-out]";
const HIGHLIGHT_SPRING: SparklineSpringConfig = { stiffness: 180, damping: 28 };
const DEFAULT_SPARKLINE_HEIGHT = 32;
/** Inner padding when `padding` is omitted, so strokes and the hover dot are not clipped. */
const DEFAULT_SPARKLINE_PADDING = 4;
const REDUCED_MOTION_FADE_MS = 200;

type SparklineCrosshair = "dashed" | "solid" | "gradient" | false;

interface SparklineSpringConfig {
  stiffness: number;
  damping: number;
}

/**
 * Same feel as the main charts' tooltip crosshair (`tooltipSpring`). Inlined
 * so the sparkline install doesn't pull in the tooltip.
 */
const DEFAULT_SPARKLINE_HOVER_SPRING: SparklineSpringConfig = {
  stiffness: 300,
  damping: 30,
};

interface SparklineBaseProps<T> {
  data: readonly T[];
  /** Field (or accessor) holding the numeric value. */
  dataKey: SparklineDataKey<T>;
  /** Fixed width in px. Omit to fill the parent width. */
  width?: number;
  /** Height in px. Defaults to 32. */
  height?: number;
  /** Series colour. Defaults to `var(--chart-line-primary)`. */
  color?: string;
  /** Inner padding so strokes and the hover dot are not clipped. */
  padding?: number | Partial<SparklinePadding>;
  /** Override the value domain; `undefined` entries fall back to the data. */
  yDomain?: [number?, number?];
  /** Play the enter animation on mount. Respects `prefers-reduced-motion`. */
  animate?: boolean;
  animationDuration?: number;
  /** Any CSS easing string. */
  animationEasing?: string;
  /**
   * Morph to new data instead of snapping, in ms. `0` snaps. Requires
   * `animate`; snaps under `prefers-reduced-motion`.
   */
  dataTransitionDuration?: number;
  /** Hover guide line. Set `false` to hide. */
  crosshair?: SparklineCrosshair;
  /** Show a dot on the hovered point. */
  dot?: boolean;
  /**
   * Spring the crosshair and dot between points, like the main charts'
   * tooltip. Snaps under `prefers-reduced-motion`.
   */
  hoverTransition?: boolean;
  /**
   * Hover spring for the crosshair and dot. Defaults to the main charts'
   * tooltip spring (300 / 30); pass only what you want to change, e.g.
   * `{ damping: 40 }`. Higher stiffness = snappier; lower damping = bouncier.
   */
  springConfig?: Partial<SparklineSpringConfig>;
  /** Disable pointer tracking entirely (no hover state, no listeners). */
  interactive?: boolean;
  /** Controlled hovered index. Pass `null` for "not hovering". */
  hoverIndex?: number | null;
  onHoverChange?: (index: number | null, datum: T | null) => void;
  /** Accessible summary. Generated from the data when omitted. */
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

interface LineSparklineProps<T> extends SparklineBaseProps<T> {
  curve?: SparklineCurve;
  strokeWidth?: number;
  /** Keep a dot on the last point when not hovering. */
  endDot?: boolean;
  /**
   * On hover, fade the series and re-stroke the segment around the hovered
   * point at full strength — the main charts' highlight. Default `true`.
   */
  showHighlight?: boolean;
  /** Series opacity while hovering (with `showHighlight`). Default `0.5`. */
  inactiveOpacity?: number;
}

interface AreaSparklineProps<T> extends LineSparklineProps<T> {
  fill?: "gradient" | "solid";
  /** Opacity of the fill at its strongest point. */
  fillOpacity?: number;
}

// One ResizeObserver for every sparkline on the page.
type SizeListener = (width: number) => void;
let sharedObserver: ResizeObserver | null = null;
const sizeListeners = new WeakMap<Element, SizeListener>();

function observeWidth(element: Element, listener: SizeListener) {
  if (typeof ResizeObserver === "undefined") {
    listener(element.getBoundingClientRect().width);
    return () => undefined;
  }
  sharedObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      sizeListeners.get(entry.target)?.(entry.contentRect.width);
    }
  });
  sizeListeners.set(element, listener);
  sharedObserver.observe(element);
  return () => {
    sizeListeners.delete(element);
    sharedObserver?.unobserve(element);
  };
}

function useSparklineWidth(
  ref: RefObject<HTMLDivElement | null>,
  fixedWidth: number | undefined,
): number {
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (fixedWidth !== undefined || !element) {
      return;
    }
    return observeWidth(element, (width) => setMeasured(Math.round(width * 2) / 2));
  }, [ref, fixedWidth]);
  return fixedWidth ?? measured;
}

/**
 * Plays the enter animation once, when the sparkline first has a size.
 * Uses WAAPI so there is no per-instance animation runtime; under reduced
 * motion the reveal becomes a short opacity fade.
 */
function useEnterAnimation(
  ref: RefObject<SVGGElement | null>,
  ready: boolean,
  options: {
    animate: boolean;
    duration: number;
    easing: string;
    keyframes: Keyframe[];
  },
) {
  const played = useRef(false);
  const { animate, duration, easing, keyframes } = options;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!(ready && element) || played.current) {
      return;
    }
    played.current = true;
    if (!animate || duration <= 0 || typeof element.animate !== "function") {
      return;
    }
    if (prefersReducedMotion()) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: REDUCED_MOTION_FADE_MS,
        easing: "ease-out",
      });
      return;
    }
    element.animate(keyframes, { duration, easing });
  }, [ref, ready, animate, duration, easing, keyframes]);
}

/** True when two layouts draw the same shape (e.g. a re-created `data` array). */
function sameShape(a: SparklineLayout, b: SparklineLayout): boolean {
  if (a === b) {
    return true;
  }
  if (a.points.length !== b.points.length || a.baselineY !== b.baselineY) {
    return false;
  }
  return a.points.every((point, i) => {
    const other = b.points[i];
    return other !== undefined && Object.is(point.y, other.y) && point.x === other.x;
  });
}

/**
 * Morphs the path(s) when the data changes, writing `d` straight to the DOM
 * each frame so React doesn't re-render. First paint and resizes snap.
 */
function useDataTransition(
  layout: SparklineLayout,
  width: number,
  duration: number,
  draw: (frame: SparklineLayout) => void,
) {
  const displayed = useRef<SparklineLayout | null>(null);
  const prevWidth = useRef(width);
  const running = useRef(false);
  const drawRef = useRef(draw);
  useLayoutEffect(() => {
    drawRef.current = draw;
  });

  useLayoutEffect(() => {
    const from = displayed.current;
    const resized = prevWidth.current !== width;
    prevWidth.current = width;
    displayed.current = layout;
    if (!from || sameShape(from, layout) || resized || duration <= 0 || prefersReducedMotion()) {
      // An interrupted tween may have left the DOM mid-frame.
      if (running.current) {
        running.current = false;
        drawRef.current(layout);
      }
      return;
    }
    const frame = (t: number) => {
      displayed.current = interpolateSparklineLayout(from, layout, t);
      drawRef.current(displayed.current);
    };
    running.current = true;
    frame(0);
    const control = animateValue(0, 1, {
      duration: duration / 1000,
      ease: [...DATA_TRANSITION_EASE],
      onUpdate: frame,
      onComplete: () => {
        running.current = false;
        displayed.current = layout;
        drawRef.current(layout);
      },
    });
    return () => control.stop();
  }, [layout, width, duration]);
}

const wipeKeyframes: Keyframe[] = [
  { clipPath: "inset(0 100% 0 0)" },
  { clipPath: "inset(0 0% 0 0)" },
];

const drawKeyframes: Keyframe[] = [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }];

function useHoverState<T>(
  data: readonly T[],
  hoverIndexProp: number | null | undefined,
  onHoverChange: SparklineBaseProps<T>["onHoverChange"],
) {
  const [internal, setInternal] = useState<number | null>(null);
  const controlled = hoverIndexProp !== undefined;
  const hoverIndex = controlled ? hoverIndexProp : internal;
  const current = useRef(hoverIndex);
  current.current = hoverIndex;

  const setHoverIndex = useCallback(
    (index: number | null) => {
      // Pointer moves inside one slot are free: no state, no callback.
      if (index === current.current) {
        return;
      }
      current.current = index;
      if (!controlled) {
        setInternal(index);
      }
      onHoverChange?.(index, index === null ? null : (data[index] ?? null));
    },
    [controlled, data, onHoverChange],
  );

  return [hoverIndex, setHoverIndex] as const;
}

interface FrameProps<T> {
  config: SparklineBaseProps<T>;
  children: (frame: {
    width: number;
    height: number;
    layout: SparklineLayout;
    values: number[];
    hoverIndex: number | null;
    color: string;
    gradientId: string;
  }) => ReactNode;
}

function SparklineFrame<T>({ config, children }: FrameProps<T>) {
  const {
    data,
    dataKey,
    width: widthProp,
    height = DEFAULT_SPARKLINE_HEIGHT,
    color = chartCssVars.linePrimary,
    padding: paddingProp,
    yDomain,
    interactive = true,
    hoverIndex: hoverIndexProp,
    onHoverChange,
    className,
    style,
  } = config;
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useSparklineWidth(containerRef, widthProp);
  const gradientId = useId();

  const values = useMemo(() => resolveSparklineValues(data, dataKey), [data, dataKey]);
  const resolvedPadding = resolveSparklinePadding(paddingProp, DEFAULT_SPARKLINE_PADDING);
  const { top, right, bottom, left } = resolvedPadding;
  // Keyed on the four numbers so inline `padding={{ … }}` literals stay cheap.
  const padding = useMemo(() => ({ top, right, bottom, left }), [top, right, bottom, left]);
  const yMin = yDomain?.[0];
  const yMax = yDomain?.[1];
  const layout = useMemo(
    () =>
      computeSparklineLayout(values, {
        width,
        height,
        padding,
        domain: computeSparklineDomain(values, { yDomain: [yMin, yMax] }),
      }),
    [values, width, height, padding, yMin, yMax],
  );

  const [hoverIndex, setHoverIndex] = useHoverState(data, hoverIndexProp, onHoverChange);

  const handlePointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHoverIndex(
        sparklineIndexAtX(event.clientX - rect.left, {
          count: values.length,
          width,
          padding,
        }),
      );
    },
    [setHoverIndex, values.length, width, padding],
  );
  const handlePointerLeave = useCallback(() => setHoverIndex(null), [setHoverIndex]);

  const { t, lang } = useUiT();
  const label = config["aria-label"] ?? describeSparkline(values, t, intlLocale(lang));

  return (
    <div
      className={cn("relative min-w-0", widthProp === undefined && "w-full", className)}
      ref={containerRef}
      style={{ width: widthProp, height, ...style }}
    >
      {width > 0 ? (
        <svg
          aria-label={label}
          className="block overflow-visible"
          height={height}
          onPointerLeave={interactive ? handlePointerLeave : undefined}
          onPointerMove={interactive ? handlePointerMove : undefined}
          role="img"
          style={interactive ? { touchAction: "pan-y" } : undefined}
          width={width}
        >
          {children({
            width,
            height,
            layout,
            values,
            hoverIndex,
            color,
            gradientId,
          })}
        </svg>
      ) : null}
    </div>
  );
}

type AnimatedNumber = number | MotionValue<number>;

function SparklineCrosshairLine({
  x,
  height,
  padding,
  variant,
  gradientId,
}: {
  x: AnimatedNumber;
  height: number;
  padding: SparklinePadding;
  variant: Exclude<SparklineCrosshair, false>;
  gradientId: string;
}) {
  const id = `${gradientId}-crosshair`;
  return (
    <m.g aria-hidden pointerEvents="none" style={{ x }}>
      {variant === "gradient" ? (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={chartCssVars.crosshair} stopOpacity="0" />
              <stop offset="0.5" stopColor={chartCssVars.crosshair} stopOpacity="1" />
              <stop offset="1" stopColor={chartCssVars.crosshair} stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Gradient strokes need a non-zero bbox width, so draw a 1px rect. */}
          <rect fill={`url(#${id})`} height={height} width={1} x={-0.5} y={0} />
        </>
      ) : (
        <line
          stroke={chartCssVars.crosshair}
          strokeDasharray={variant === "dashed" ? "2 2" : undefined}
          strokeWidth={1}
          x1={0}
          x2={0}
          y1={padding.top / 2}
          y2={height - padding.bottom / 2}
        />
      )}
    </m.g>
  );
}

function SparklineDot({ x, y, color }: { x: AnimatedNumber; y: AnimatedNumber; color: string }) {
  return (
    <m.circle
      aria-hidden
      cx={x}
      cy={y}
      fill={color}
      pointerEvents="none"
      r={3}
      stroke={chartCssVars.background}
      strokeWidth={1.5}
    />
  );
}

interface HoverMarksProps {
  point: SparklineLayout["points"][number];
  /** Where the dot rests when the hovered value is missing. */
  fallbackY: number;
  height: number;
  padding: SparklinePadding;
  crosshair: SparklineCrosshair;
  dot: boolean;
  color: string;
  gradientId: string;
}

function HoverMarksView({
  x,
  y,
  showDot,
  height,
  padding,
  crosshair,
  dot,
  color,
  gradientId,
}: Omit<HoverMarksProps, "point" | "fallbackY"> & {
  x: AnimatedNumber;
  y: AnimatedNumber;
  showDot: boolean;
}) {
  return (
    <>
      {crosshair ? (
        <SparklineCrosshairLine
          gradientId={gradientId}
          height={height}
          padding={padding}
          variant={crosshair}
          x={x}
        />
      ) : null}
      {dot && showDot ? <SparklineDot color={color} x={x} y={y} /> : null}
    </>
  );
}

/**
 * Crosshair + dot follow the pointer on the same spring as the main charts'
 * tooltip. Only mounted while hovering, so idle sparklines create no springs;
 * the springs start at the first hovered point rather than sliding in.
 */
function SpringHoverMarks({
  point,
  fallbackY,
  spring,
  ...rest
}: HoverMarksProps & { spring: SparklineSpringConfig }) {
  const targetY = Number.isFinite(point.y) ? point.y : fallbackY;
  const x = useSpring(point.x, spring);
  const y = useSpring(targetY, spring);
  useLayoutEffect(() => {
    x.set(point.x);
    y.set(targetY);
  }, [x, y, point.x, targetY]);
  return <HoverMarksView showDot={Number.isFinite(point.y)} x={x} y={y} {...rest} />;
}

function HoverMarks({
  spring,
  point,
  fallbackY,
  ...rest
}: HoverMarksProps & { spring: SparklineSpringConfig | null }) {
  const reducedMotion = usePrefersReducedMotion();
  if (spring && !reducedMotion) {
    return <SpringHoverMarks fallbackY={fallbackY} point={point} spring={spring} {...rest} />;
  }
  return <HoverMarksView showDot={Number.isFinite(point.y)} x={point.x} y={point.y} {...rest} />;
}

/**
 * Re-strokes the series path clipped to a band from the previous to the next
 * point; the band springs as the hovered index moves. Only mounted while
 * hovering, so idle sparklines carry no springs.
 */
function SparklineHighlight({
  layout,
  hoverIndex,
  height,
  lineRef,
  stroke,
  strokeWidth,
}: {
  layout: SparklineLayout;
  hoverIndex: number;
  height: number;
  lineRef: RefObject<SVGPathElement | null>;
  stroke: string;
  strokeWidth: number;
}) {
  const clipId = useId();
  const highlightRef = useRef<SVGPathElement>(null);
  const { points } = layout;
  const start = points[Math.max(0, hoverIndex - 1)]?.x ?? 0;
  const end = points[Math.min(points.length - 1, hoverIndex + 1)]?.x ?? 0;
  const x = useSpring(start, HIGHLIGHT_SPRING);
  const width = useSpring(end - start, HIGHLIGHT_SPRING);

  useLayoutEffect(() => {
    // Reuse the base stroke's `d` — it may be mid data-transition.
    highlightRef.current?.setAttribute("d", lineRef.current?.getAttribute("d") ?? "");
    if (prefersReducedMotion()) {
      x.jump(start);
      width.jump(end - start);
    } else {
      x.set(start);
      width.set(end - start);
    }
  });

  return (
    <g aria-hidden pointerEvents="none">
      <defs>
        <clipPath id={clipId}>
          {/* Bleed by strokeWidth so strokes at the min/max keep full width. */}
          <m.rect height={height + strokeWidth * 2} width={width} x={x} y={-strokeWidth} />
        </clipPath>
      </defs>
      <m.path
        animate={{ opacity: 1 }}
        clipPath={`url(#${clipId})`}
        fill="none"
        initial={{ opacity: 0 }}
        ref={highlightRef}
        stroke={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        transition={{ duration: 0.4, ease: "easeInOut" }}
      />
    </g>
  );
}

function HoverOverlay({
  layout,
  hoverIndex,
  spring,
  ...rest
}: Omit<HoverMarksProps, "point" | "fallbackY"> & {
  layout: SparklineLayout;
  hoverIndex: number | null;
  spring: SparklineSpringConfig | null;
}) {
  const point = hoverIndex === null ? undefined : layout.points[hoverIndex];
  if (!point) {
    return null;
  }
  return <HoverMarks fallbackY={layout.baselineY} point={point} spring={spring} {...rest} />;
}

/** Resolves the hover spring: `null` means snap. */
function resolveHoverSpring(
  hoverTransition: boolean,
  springConfig: Partial<SparklineSpringConfig> | undefined,
): SparklineSpringConfig | null {
  return hoverTransition ? { ...DEFAULT_SPARKLINE_HOVER_SPRING, ...springConfig } : null;
}

function LineOrArea<T>({
  config,
  variant,
}: {
  config: AreaSparklineProps<T>;
  variant: "line" | "area";
}) {
  const {
    curve = "monotone",
    strokeWidth = 1.5,
    endDot = false,
    fill = "gradient",
    fillOpacity = variant === "area" ? 0.3 : 0,
    animate = true,
    animationDuration = DEFAULT_SPARKLINE_ANIMATION_DURATION_MS,
    animationEasing = DEFAULT_ANIMATION_EASING,
    dataTransitionDuration = DEFAULT_SPARKLINE_DATA_TRANSITION_MS,
    crosshair = "dashed",
    dot = true,
    hoverTransition = true,
    springConfig,
    showHighlight = true,
    inactiveOpacity = 0.5,
  } = config;
  const spring = resolveHoverSpring(hoverTransition, springConfig);
  const padding = resolveSparklinePadding(config.padding, DEFAULT_SPARKLINE_PADDING);
  const groupRef = useRef<SVGGElement>(null);
  const lineRef = useRef<SVGPathElement>(null);

  return (
    <SparklineFrame config={config}>
      {({ width, height, layout, hoverIndex, color, gradientId }) => (
        <LineOrAreaPaths
          animate={animate}
          animationDuration={animationDuration}
          animationEasing={animationEasing}
          color={color}
          crosshair={crosshair}
          curve={curve}
          dataTransitionDuration={animate ? dataTransitionDuration : 0}
          dot={dot}
          endDot={endDot}
          fill={fill}
          fillOpacity={fillOpacity}
          gradientId={gradientId}
          groupRef={groupRef}
          height={height}
          hoverIndex={hoverIndex}
          inactiveOpacity={showHighlight ? inactiveOpacity : 1}
          layout={layout}
          lineRef={lineRef}
          padding={padding}
          showHighlight={showHighlight}
          spring={spring}
          strokeWidth={strokeWidth}
          variant={variant}
          width={width}
        />
      )}
    </SparklineFrame>
  );
}

function LineOrAreaPaths({
  variant,
  layout,
  width,
  height,
  padding,
  curve,
  strokeWidth,
  color,
  fill,
  fillOpacity,
  endDot,
  hoverIndex,
  crosshair,
  dot,
  gradientId,
  animate,
  animationDuration,
  animationEasing,
  dataTransitionDuration,
  groupRef,
  lineRef,
  spring,
  showHighlight,
  inactiveOpacity,
}: {
  variant: "line" | "area";
  layout: SparklineLayout;
  width: number;
  height: number;
  padding: SparklinePadding;
  curve: SparklineCurve;
  strokeWidth: number;
  color: string;
  fill: "gradient" | "solid";
  fillOpacity: number;
  endDot: boolean;
  hoverIndex: number | null;
  crosshair: SparklineCrosshair;
  dot: boolean;
  gradientId: string;
  animate: boolean;
  animationDuration: number;
  animationEasing: string;
  dataTransitionDuration: number;
  groupRef: RefObject<SVGGElement | null>;
  lineRef: RefObject<SVGPathElement | null>;
  spring: SparklineSpringConfig | null;
  showHighlight: boolean;
  inactiveOpacity: number;
}) {
  const linePath = useMemo(() => buildSparklineLinePath(layout.points, curve), [layout, curve]);
  const areaPath = useMemo(
    () =>
      variant === "area" ? buildSparklineAreaPath(layout.points, curve, layout.baselineY) : "",
    [variant, layout, curve],
  );

  const areaRef = useRef<SVGPathElement>(null);
  useDataTransition(layout, width, dataTransitionDuration, (frame) => {
    lineRef.current?.setAttribute("d", buildSparklineLinePath(frame.points, curve));
    areaRef.current?.setAttribute(
      "d",
      buildSparklineAreaPath(frame.points, curve, frame.baselineY),
    );
  });

  // Line draws in along its stroke; area wipes in left → right.
  useEnterAnimation(variant === "line" ? lineRef : groupRef, width > 0, {
    animate,
    duration: animationDuration,
    easing: animationEasing,
    keyframes: variant === "line" ? drawKeyframes : wipeKeyframes,
  });

  const fillId = `${gradientId}-fill`;
  let last: SparklineLayout["points"][number] | undefined;
  for (let i = layout.points.length - 1; i >= 0 && !last; i--) {
    const point = layout.points[i];
    if (point && Number.isFinite(point.y)) {
      last = point;
    }
  }

  return (
    <>
      <g
        aria-hidden
        className={HOVER_FADE_CLASS}
        ref={groupRef}
        style={{ opacity: hoverIndex === null ? 1 : inactiveOpacity }}
      >
        {variant === "area" ? (
          <>
            {fill === "gradient" ? (
              <defs>
                <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={color} stopOpacity={fillOpacity} />
                  <stop offset="1" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
            ) : null}
            <path
              d={areaPath}
              fill={fill === "gradient" ? `url(#${fillId})` : color}
              fillOpacity={fill === "gradient" ? 1 : fillOpacity}
              ref={areaRef}
            />
          </>
        ) : null}
        <path
          d={linePath}
          fill="none"
          pathLength={1}
          ref={lineRef}
          stroke={color}
          strokeDasharray={variant === "line" ? 1 : undefined}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={strokeWidth}
        />
      </g>
      {showHighlight && hoverIndex !== null ? (
        <SparklineHighlight
          height={height}
          hoverIndex={hoverIndex}
          layout={layout}
          lineRef={lineRef}
          stroke={color}
          strokeWidth={strokeWidth}
        />
      ) : null}
      {endDot && hoverIndex === null && last ? (
        <SparklineDot color={color} x={last.x} y={last.y} />
      ) : null}
      <HoverOverlay
        color={color}
        crosshair={crosshair}
        dot={dot}
        gradientId={gradientId}
        height={height}
        hoverIndex={hoverIndex}
        layout={layout}
        padding={padding}
        spring={spring}
      />
    </>
  );
}

function AreaSparklineImpl<T>(props: AreaSparklineProps<T>) {
  return (
    <LazyMotion features={domAnimation}>
      <LineOrArea config={props} variant="area" />
    </LazyMotion>
  );
}

/** Tiny area chart — line over a gradient or solid fill. */
export const AreaSparkline = memo(AreaSparklineImpl) as typeof AreaSparklineImpl;
