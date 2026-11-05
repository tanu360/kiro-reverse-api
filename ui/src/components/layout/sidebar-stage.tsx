import type { CSSProperties, JSX } from "react";

/**
 * The sky behind the sidebar's top row: dots and four-point stars on the sidebar's own colour,
 * some of them twinkling, fading out towards the first row (see `.sidebar-stage-backdrop` in
 * index.css). No fill of its own, so it reads as the sidebar in either theme.
 *
 * The SVG is 8192 units wide and sliced from the top left, so the 96-unit height fills the 80 px
 * strip and the sidebar shows as much of the left as fits (about 330 units open, 57 collapsed).
 * The 288-unit tile is drawn twice. Decorative only.
 */
export function SidebarStage(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 -z-10 h-20 select-none overflow-hidden"
    >
      <svg
        aria-hidden="true"
        className="h-full w-full"
        data-stage-art="kiro-stars"
        fill="none"
        preserveAspectRatio="xMinYMin slice"
        viewBox="0 0 8192 96"
        xmlns="http://www.w3.org/2000/svg"
      >
        {[0, TILE].map((offset) => (
          <g key={offset} transform={`translate(${offset} 0)`}>
            <g style={{ fill: "var(--stage-star)" }}>
              {DOTS.map((dot) => (
                <circle
                  className={dot.twinkle ? "sidebar-stage-twinkle" : undefined}
                  cx={dot.cx}
                  cy={dot.cy}
                  fillOpacity={dot.opacity}
                  key={`${dot.cx}-${dot.cy}`}
                  r={dot.r}
                  style={dot.twinkle ? twinkle(dot.twinkle) : undefined}
                />
              ))}
            </g>
            <g style={{ fill: "var(--stage-sparkle)" }}>
              {SPARKLES.map((sparkle) => (
                <path
                  className="sidebar-stage-twinkle sidebar-stage-sparkle"
                  d={sparklePath(sparkle)}
                  key={`${sparkle.x}-${sparkle.y}`}
                  style={twinkle(sparkle.twinkle)}
                />
              ))}
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}

const TILE = 288;

type Twinkle = { duration: number; delay: number };

/** Dots across the tile, fewer and fainter lower down; about half of them twinkle. */
const DOTS: { cx: number; cy: number; r: number; opacity: number; twinkle?: Twinkle }[] = [
  { cx: 10, cy: 12, r: 1.19, opacity: 0.8, twinkle: { duration: 3.2, delay: 0 } },
  { cx: 31, cy: 27, r: 0.85, opacity: 0.5 },
  { cx: 52, cy: 9, r: 1.02, opacity: 0.7, twinkle: { duration: 4.1, delay: 1.3 } },
  { cx: 77, cy: 19, r: 0.85, opacity: 0.45 },
  { cx: 99, cy: 6, r: 1.27, opacity: 0.85, twinkle: { duration: 3.6, delay: 2.2 } },
  { cx: 121, cy: 23, r: 0.85, opacity: 0.5, twinkle: { duration: 4.6, delay: 0.7 } },
  { cx: 141, cy: 13, r: 1.02, opacity: 0.7 },
  { cx: 163, cy: 28, r: 0.85, opacity: 0.45, twinkle: { duration: 3.9, delay: 2.9 } },
  { cx: 186, cy: 8, r: 1.19, opacity: 0.8 },
  { cx: 205, cy: 21, r: 0.85, opacity: 0.5, twinkle: { duration: 3.3, delay: 1.8 } },
  { cx: 226, cy: 5, r: 1.02, opacity: 0.65 },
  { cx: 248, cy: 26, r: 0.85, opacity: 0.5, twinkle: { duration: 4.3, delay: 0.4 } },
  { cx: 271, cy: 15, r: 1.19, opacity: 0.75 },
  { cx: 19, cy: 38, r: 0.85, opacity: 0.4 },
  { cx: 109, cy: 37, r: 0.85, opacity: 0.4, twinkle: { duration: 5, delay: 3.4 } },
  { cx: 196, cy: 40, r: 0.85, opacity: 0.45 },
  { cx: 282, cy: 36, r: 0.85, opacity: 0.4, twinkle: { duration: 4.8, delay: 2.5 } },
];

/** Four-point stars, all twinkling, out of step with each other. */
const SPARKLES: { x: number; y: number; s: number; twinkle: Twinkle }[] = [
  { x: 64, y: 30, s: 3.2, twinkle: { duration: 3.8, delay: 0.6 } },
  { x: 152, y: 40, s: 2.8, twinkle: { duration: 4.4, delay: 2.1 } },
  { x: 214, y: 13, s: 3.6, twinkle: { duration: 3.4, delay: 1.2 } },
];

function twinkle({ duration, delay }: Twinkle): CSSProperties {
  return { animationDelay: `${delay}s`, animationDuration: `${duration}s` };
}

function sparklePath({ x, y, s }: { x: number; y: number; s: number }): string {
  const k = s * 0.22;
  return `M${x} ${y - s}C${x + k} ${y - k} ${x + k} ${y - k} ${x + s} ${y}C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + s}C${x - k} ${y + k} ${x - k} ${y + k} ${x - s} ${y}C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - s}Z`;
}
