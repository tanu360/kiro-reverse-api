import { type JSX, type ReactNode, useId } from "react";
import type { SupportedLang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Small waving country flags for the language picker, drawn inline: emoji flags do not render on
 * Windows. Each flag is a 30×20 (3:2) cloth on a 32×26 canvas, rippling through one sine period
 * from left to right; stripes and bands follow the ripple, emblems ride it, and a soft light and
 * shade gradient gives the folds. No frame: the wave itself is the edge. Simplified to read at
 * about 22 px (the US canton keeps a grid of dots, not 50 stars).
 */

const LEFT = 1;
const RIGHT = 31;
const TOP = 3;
const HEIGHT = 20;
/** The cubic handles' lift: 3 bends each edge about 2.25 units off its baseline. */
const LIFT = 3;
/** The ripple's peak height, as drawn by the cubics below. */
const AMPLITUDE = 0.75 * LIFT;

/** How far the cloth is lifted at `x`: up over the first half, down over the second. */
function ripple(x: number): number {
  return -AMPLITUDE * Math.sin((2 * Math.PI * (x - LEFT)) / (RIGHT - LEFT));
}

/** A rippling band of the cloth from `from` to `to` (0 is the top edge, 20 the bottom). */
function band(from: number, to: number): string {
  const top = TOP + from;
  const bottom = TOP + to;
  return [
    `M${LEFT} ${top}`,
    `C6 ${top - LIFT} 11 ${top - LIFT} 16 ${top}`,
    `S26 ${top + LIFT} ${RIGHT} ${top}`,
    `L${RIGHT} ${bottom}`,
    `C26 ${bottom + LIFT} 21 ${bottom + LIFT} 16 ${bottom}`,
    `S6 ${bottom - LIFT} ${LEFT} ${bottom}`,
    "Z",
  ].join("");
}

const CLOTH = band(0, HEIGHT);

/** A point on the flat flag (x 0-30, y 0-20), moved onto the rippling cloth. */
function onCloth(x: number, y: number): [number, number] {
  return [LEFT + x, TOP + y + ripple(LEFT + x)];
}

/** A five-point star's polygon points on the cloth, one tip at `tipDegrees` (-90 is up). */
function star(cx: number, cy: number, radius: number, tipDegrees = -90): string {
  const [x, y] = onCloth(cx, cy);
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const r = index % 2 === 0 ? radius : radius * 0.382;
    const angle = ((tipDegrees + index * 36) * Math.PI) / 180;
    points.push(`${(x + r * Math.cos(angle)).toFixed(2)},${(y + r * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(" ");
}

/** A small star of the Chinese flag: one tip points at the large star's centre (5, 5). */
function towardBigStar(cx: number, cy: number): string {
  return star(cx, cy, 1, (Math.atan2(5 - cy, 5 - cx) * 180) / Math.PI);
}

function points(...corners: [number, number][]): string {
  return corners.map(([x, y]) => onCloth(x, y).join(",")).join(" ");
}

const US_STRIPE = HEIGHT / 13;
const US_STAR_ROWS = [1.8, 4.2, 6.6, 9];
const US_STAR_COLUMNS = [1.8, 4.6, 7.4, 10.2];
const [BR_X, BR_Y] = onCloth(15, 10);

const FLAGS: Record<SupportedLang, ReactNode> = {
  // United States (English uses the en-US locale).
  en: (
    <>
      <path d={CLOTH} fill="#fff" />
      {[0, 2, 4, 6, 8, 10, 12].map((stripe) => (
        <path d={band(stripe * US_STRIPE, (stripe + 1) * US_STRIPE)} fill="#b22234" key={stripe} />
      ))}
      {/* The canton: the top seven stripes' band, cut to the hoist by a nested viewport. */}
      <svg
        aria-hidden="true"
        height="26"
        overflow="hidden"
        width="12"
        x={LEFT}
        y="0"
        viewBox={`${LEFT} 0 12 26`}
      >
        <path d={band(0, US_STRIPE * 7)} fill="#3c3b6e" />
      </svg>
      <g fill="#fff">
        {US_STAR_ROWS.flatMap((y) =>
          US_STAR_COLUMNS.map((x) => {
            const [cx, cy] = onCloth(x, y);
            return <circle cx={cx} cy={cy} key={`${x}-${y}`} r="0.55" />;
          }),
        )}
      </g>
    </>
  ),
  // China: the flag's own 30×20 grid.
  zh: (
    <>
      <path d={CLOTH} fill="#ee1c25" />
      <g fill="#ffde00">
        <polygon points={star(5, 5, 3)} />
        <polygon points={towardBigStar(10, 2)} />
        <polygon points={towardBigStar(12, 4)} />
        <polygon points={towardBigStar(12, 7)} />
        <polygon points={towardBigStar(10, 9)} />
      </g>
    </>
  ),
  // Vietnam.
  vi: (
    <>
      <path d={CLOTH} fill="#da251d" />
      <polygon fill="#ffde00" points={star(15, 10, 6)} />
    </>
  ),
  // Brazil.
  "pt-BR": (
    <>
      <path d={CLOTH} fill="#009c3b" />
      <polygon fill="#ffdf00" points={points([3, 10], [15, 2.4], [27, 10], [15, 17.6])} />
      <circle cx={BR_X} cy={BR_Y} fill="#002776" r="5" />
      <path
        d={`M${BR_X - 4.8} ${BR_Y + 0.6}A8 8 0 0 1 ${BR_X + 4.75} ${BR_Y + 1.5}`}
        fill="none"
        stroke="#fff"
        strokeWidth="0.9"
      />
    </>
  ),
};

/** A waving flag, about 22×18 px; size it with `className`. */
export function FlagIcon({
  code,
  className,
}: {
  code: SupportedLang;
  className?: string;
}): JSX.Element {
  const shadeId = `flag-shade-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex h-4.5 w-5.5 shrink-0", className)}
      data-slot="flag-icon"
    >
      {/* opacity-100 and size-full opt out of the icon dimming and sizing rules in buttons. */}
      <svg
        aria-hidden="true"
        className="block size-full overflow-visible opacity-100"
        viewBox="0 0 32 26"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Light on the crests, shade in the troughs: one fold per half wave. */}
          <linearGradient id={shadeId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#000" stopOpacity="0.06" />
            <stop offset="0.25" stopColor="#fff" stopOpacity="0.28" />
            <stop offset="0.55" stopColor="#000" stopOpacity="0.16" />
            <stop offset="0.8" stopColor="#fff" stopOpacity="0.18" />
            <stop offset="1" stopColor="#000" stopOpacity="0.12" />
          </linearGradient>
        </defs>
        {FLAGS[code]}
        <path d={CLOTH} fill={`url(#${shadeId})`} />
      </svg>
    </span>
  );
}
