import type { JSX } from "react";

/** The quiet zone drawn round the code, in modules: enough for a phone camera on a white tile. */
const QUIET = 2;
/** A data module's dot radius, in modules: round, but large enough to read like a square. */
const DOT = 0.46;
/** Finder patterns (the three corner eyes) are 7 modules square. */
const EYE = 7;

export interface QrModules {
  size: number;
  dark: boolean[][];
}

/**
 * The module grid of the server's QR SVG (totp.QRSVG): one "M{x} {y}h{run}v1h-{run}z" run per
 * row of dark modules, offset by its quiet zone. Null for anything else, so the caller can show
 * the SVG itself instead.
 */
export function parseQrSvg(svg: string): QrModules | null {
  const view = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!view) return null;
  const runs = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)].map((run) => ({
    x: Number(run[1]),
    y: Number(run[2]),
    n: Number(run[3]),
  }));
  if (runs.length === 0) return null;
  // The top-left eye's corner is always dark, so the smallest x and y are the quiet zone.
  const quiet = Math.min(...runs.map((run) => Math.min(run.x, run.y)));
  const size = Number(view[1]) - 2 * quiet;
  if (size < 21) return null;
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (const run of runs) {
    const row = dark[run.y - quiet];
    if (!row) return null;
    for (let i = 0; i < run.n; i += 1) {
      const x = run.x - quiet + i;
      if (x < 0 || x >= size) return null;
      row[x] = true;
    }
  }
  return { size, dark };
}

function inEye(x: number, y: number, size: number): boolean {
  const near = (v: number) => v < EYE;
  const far = (v: number) => v >= size - EYE;
  return (near(x) && near(y)) || (far(x) && near(y)) || (near(x) && far(y));
}

/**
 * The QR code drawn in the app's style: round dots for the data and rounded corner eyes in Kiro
 * purple, on a white tile with rounded corners. The colours are the --qr-* tokens.
 */
export function StyledQr({ modules, label }: { modules: QrModules; label: string }): JSX.Element {
  const { size, dark } = modules;
  const side = size + 2 * QUIET;
  // Every dot in one path: a circle is two arcs from its left edge.
  let dots = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!dark[y]?.[x] || inEye(x, y, size)) continue;
      const cx = x + QUIET + 0.5;
      const cy = y + QUIET + 0.5;
      dots += `M${cx - DOT} ${cy}a${DOT} ${DOT} 0 1 0 ${2 * DOT} 0a${DOT} ${DOT} 0 1 0 ${-2 * DOT} 0`;
    }
  }
  const eyes = [
    [0, 0],
    [size - EYE, 0],
    [0, size - EYE],
  ] as const;
  return (
    <svg aria-label={label} className="block size-full" role="img" viewBox={`0 0 ${side} ${side}`}>
      <rect fill="var(--qr-tile)" height={side} rx={QUIET * 1.25} width={side} />
      <path d={dots} fill="var(--qr-module)" />
      {eyes.map(([ex, ey]) => (
        <g fill="var(--qr-eye)" key={`${ex}-${ey}`}>
          <rect
            fill="none"
            height={EYE - 1}
            rx={1.9}
            stroke="var(--qr-eye)"
            strokeWidth={1}
            width={EYE - 1}
            x={ex + QUIET + 0.5}
            y={ey + QUIET + 0.5}
          />
          <rect height={3} rx={0.9} width={3} x={ex + QUIET + 2} y={ey + QUIET + 2} />
        </g>
      ))}
    </svg>
  );
}
