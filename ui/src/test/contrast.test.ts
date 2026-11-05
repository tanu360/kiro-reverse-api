import colors from "tailwindcss/colors";
import { describe, expect, it } from "vitest";

/*
 * WCAG contrast of the theme tokens in ui/src/index.css, in both themes, with no browser: the
 * token values are read from the top-level `:root` / `.dark` / `@theme` blocks, `var()`
 * references are expanded, and the colour functions the file uses (hex, rgb, oklch,
 * color-mix in srgb or oklab, Tailwind's --alpha) are evaluated the way the browser does
 * (premultiplied mixing; see-through layers composited in sRGB over what is under them).
 */

// The test config turns CSS imports off (`css: false`, so `?raw` comes back empty): read the file
// from disk. The app's tsconfig has no Node types, hence the narrow shape.
const fs = (await import("node:fs" as string)) as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const { process } = globalThis as unknown as { process: { cwd(): string } };
// Vitest runs from ui/ (the folder of vite.config.ts).
const indexCss = fs.readFileSync(`${process.cwd()}/src/index.css`, "utf8");

type Theme = "light" | "dark";
type Vars = Map<string, string>;
/** sRGB channels 0..1 and alpha 0..1. */
type RGBA = [number, number, number, number];

// --- Reading the tokens -------------------------------------------------------------------

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The top-level blocks of a stylesheet: [prelude, body]. */
function topLevelBlocks(css: string): [string, string][] {
  const blocks: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let prelude = "";
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (char === "{") {
      if (depth === 0) {
        prelude = css.slice(start, i).trim();
        start = i + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push([prelude, css.slice(start, i)]);
        start = i + 1;
      }
    } else if (char === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return blocks;
}

/** `--name: value;` declarations directly in a block body (nested blocks are skipped). */
function declarations(body: string): [string, string][] {
  const found: [string, string][] = [];
  let depth = 0;
  let paren = 0;
  let current = "";
  for (const char of body) {
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      current = "";
      continue;
    }
    if (depth > 0) continue;
    if (char === "(") paren += 1;
    if (char === ")") paren -= 1;
    if (char === ";" && paren === 0) {
      const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]*)$/.exec(current);
      if (match) found.push([match[1], match[2].replace(/\s+/g, " ").trim()]);
      current = "";
      continue;
    }
    current += char;
  }
  return found;
}

function themeVars(css: string): Record<Theme, Vars> {
  const light: Vars = new Map();
  const dark: Vars = new Map();
  // Tailwind's palette, as `@import "tailwindcss"` defines it.
  for (const [name, value] of Object.entries(colors)) {
    if (typeof value === "string") light.set(`--color-${name}`, value);
    else
      for (const [shade, hex] of Object.entries(value)) light.set(`--color-${name}-${shade}`, hex);
  }
  const darkOnly: [string, string][] = [];
  for (const [prelude, body] of topLevelBlocks(stripComments(css))) {
    const selectors = prelude.split(",").map((part) => part.trim());
    if (prelude.startsWith("@theme") || selectors.includes(":root")) {
      for (const [name, value] of declarations(body)) light.set(name, value);
    } else if (selectors.includes(".dark")) {
      darkOnly.push(...declarations(body));
    }
  }
  for (const [name, value] of light) dark.set(name, value);
  for (const [name, value] of darkOnly) dark.set(name, value);
  return { light, dark };
}

/** Replaces every var(--x[, fallback]) with its value, recursively. */
function expand(value: string, vars: Vars, depth = 0): string {
  if (depth > 32) throw new Error(`var() loop in ${value}`);
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    const end = closingParen(value, at + 3);
    const [name, ...fallback] = splitTopLevel(value.slice(at + 4, end), ",");
    const resolved = vars.get(name.trim()) ?? fallback.join(",").trim();
    if (!resolved) throw new Error(`unknown token ${name.trim()}`);
    out += expand(resolved, vars, depth + 1);
    i = end + 1;
  }
  return out;
}

function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced: ${text}`);
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

// --- Colour maths ---------------------------------------------------------------------------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

function oklabToRgb([l, a, b]: [number, number, number]): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((c) => clamp(toGamma(c))) as [number, number, number];
}

function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363015887 * lg + 0.0514770813 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const number = (text: string, scale = 1) =>
  text.endsWith("%") ? Number.parseFloat(text) / 100 : Number.parseFloat(text) / scale;
const channel = (text: string) => (text === "none" ? 0 : Number.parseFloat(text));

/** Parses a fully expanded CSS colour. */
function parseColour(input: string): RGBA {
  const text = input.trim();
  if (text === "transparent") return [0, 0, 0, 0];
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const values = full.match(/../g)?.map((pair) => Number.parseInt(pair, 16) / 255) ?? [];
    return [values[0], values[1], values[2], values[3] ?? 1];
  }
  const fn = /^([\w-]+)\(([\s\S]*)\)$/.exec(text);
  if (!fn) throw new Error(`not a colour: ${text}`);
  const [, name, args] = fn;
  if (name === "color-mix") return colorMix(args);
  if (name === "--alpha") {
    const [colour, alpha] = splitTopLevel(args, "/");
    const [r, g, b, a] = parseColour(colour);
    return [r, g, b, a * number(alpha.trim())];
  }
  const [channels, alphaText] = args.split("/");
  const parts = channels.trim().split(/[\s,]+/);
  const alpha = alphaText ? number(alphaText.trim()) : 1;
  if (name === "rgb" || name === "rgba") {
    const [r, g, b] = parts.map((part) => number(part, 255));
    return [r, g, b, parts[3] ? number(parts[3]) : alpha];
  }
  if (name === "oklch") {
    const l = number(parts[0]);
    const c = channel(parts[1]);
    const h = (channel(parts[2]) * Math.PI) / 180;
    const [r, g, b] = oklabToRgb([l, c * Math.cos(h), c * Math.sin(h)]);
    return [r, g, b, alpha];
  }
  throw new Error(`unsupported colour function ${name}`);
}

/** color-mix(in srgb|oklab, a [p], b [p]) with premultiplied alpha, as CSS Color 5 defines. */
function colorMix(args: string): RGBA {
  const [space, ...items] = splitTopLevel(args, ",").map((part) => part.trim());
  const parsed = items.map((item) => {
    const percent = /(?:^|\s)([\d.]+%)(?:\s|$)/.exec(item);
    const colour = percent ? item.replace(percent[0], " ").trim() : item;
    return { colour: parseColour(colour), weight: percent ? number(percent[1]) : undefined };
  });
  const [first, second] = parsed;
  let w1 = first.weight;
  let w2 = second.weight;
  if (w1 === undefined && w2 === undefined) [w1, w2] = [0.5, 0.5];
  else if (w1 === undefined) w1 = 1 - (w2 as number);
  else if (w2 === undefined) w2 = 1 - w1;
  // Weights summing over 100 % are scaled down; under 100 % the leftover becomes transparency.
  const total = (w1 as number) + (w2 as number);
  const [p1, p2] = [(w1 as number) / total, (w2 as number) / total];
  const convert = (rgba: RGBA): [number, number, number] =>
    space.endsWith("oklab") ? rgbToOklab([rgba[0], rgba[1], rgba[2]]) : [rgba[0], rgba[1], rgba[2]];
  const [c1, c2] = [convert(first.colour), convert(second.colour)];
  const [a1, a2] = [first.colour[3], second.colour[3]];
  const alpha = a1 * p1 + a2 * p2;
  const mixed: [number, number, number] =
    alpha === 0
      ? [0, 0, 0]
      : ([0, 1, 2].map((i) => (c1[i] * a1 * p1 + c2[i] * a2 * p2) / alpha) as [
          number,
          number,
          number,
        ]);
  const [r, g, b] = space.endsWith("oklab") ? oklabToRgb(mixed) : mixed.map(clamp);
  return [r, g, b, alpha * Math.min(total, 1)];
}

/** Paints the layers bottom to top over white, compositing in sRGB as the browser does. */
function paint(layers: RGBA[]): [number, number, number] {
  let out: [number, number, number] = [1, 1, 1];
  for (const [r, g, b, a] of layers) {
    out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
  }
  return out;
}

function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --- The pairs ------------------------------------------------------------------------------

const vars = themeVars(indexCss);
const token = (theme: Theme, name: string) => parseColour(expand(`var(--${name})`, vars[theme]));

/** [label, foreground token, surface tokens bottom to top, minimum ratio]. */
const PAIRS: [string, string, string[], number][] = [
  ["foreground on the page", "foreground", ["background"], 4.5],
  ["foreground on a card", "foreground", ["background", "card"], 4.5],
  ["muted-foreground on the page", "muted-foreground", ["background"], 4.5],
  ["muted-foreground on a card", "muted-foreground", ["background", "card"], 4.5],
  ["muted-foreground on a field", "muted-foreground", ["background", "card", "field"], 4.5],
  [
    "muted-foreground on a selected row",
    "muted-foreground",
    ["background", "surface-inset", "row-selected"],
    4.5,
  ],
  [
    "muted-foreground on a selected card row",
    "muted-foreground",
    ["background", "card", "row-selected"],
    4.5,
  ],
  ["muted-foreground on a popup", "muted-foreground", ["background", "popup"], 4.5],
  ["primary-foreground on primary", "primary-foreground", ["primary"], 4.5],
  [
    "destructive-solid-foreground on destructive-solid",
    "destructive-solid-foreground",
    ["destructive-solid"],
    4.5,
  ],
  ["success-foreground on a card", "success-foreground", ["background", "card"], 4.5],
  ["warning-foreground on a card", "warning-foreground", ["background", "card"], 4.5],
  ["destructive-foreground on a card", "destructive-foreground", ["background", "card"], 4.5],
  ["info-foreground on a card", "info-foreground", ["background", "card"], 4.5],
  ["field-border-focus on a card", "field-border-focus", ["background", "card"], 3],
  ["border-strong on a card", "border-strong", ["background", "card"], 3],
  ["success disc on a card", "success", ["background", "card"], 3],
  ["warning disc on a card", "warning", ["background", "card"], 3],
  ["ring on the page", "ring", ["background"], 3],
];

function ratio(theme: Theme, fg: string, surfaces: string[]): number {
  const layers = surfaces.map((name) => token(theme, name));
  const bg = paint(layers);
  const front = paint([...layers, token(theme, fg)]);
  return Math.round(contrast(front, bg) * 100) / 100;
}

describe("theme token contrast", () => {
  it("reads the tokens of both themes", () => {
    expect(expand("var(--background)", vars.dark)).toBe("#09090a");
    expect(vars.light.get("--background")).toBe("var(--color-zinc-50)");
    expect(vars.dark.get("--muted-foreground")).not.toBe(vars.light.get("--muted-foreground"));
  });

  it("evaluates colours like the browser", () => {
    const rgb = (rgba: RGBA) => rgba.slice(0, 3).map((c) => Math.round(c * 255));
    expect(rgb(parseColour("#9046ff"))).toEqual([144, 70, 255]);
    // Tailwind zinc-50, oklch(98.5% 0 none) = #fafafa.
    expect(rgb(parseColour("oklch(98.5% 0 none)"))).toEqual([250, 250, 250]);
    expect(parseColour("color-mix(in oklab, #fff 8%, transparent)")[3]).toBeCloseTo(0.08);
    expect(rgb(parseColour("color-mix(in srgb, #000, #fff 25%)"))).toEqual([64, 64, 64]);
    expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21);
  });

  for (const theme of ["light", "dark"] as const) {
    describe(theme, () => {
      it.each(PAIRS)("%s", (_label, fg, surfaces, min) => {
        expect(ratio(theme, fg, surfaces)).toBeGreaterThanOrEqual(min);
      });
    });
  }
});
