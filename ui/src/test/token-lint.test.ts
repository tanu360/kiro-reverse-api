import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { fields, isAstNode, isNode } from "./babel-ast";
import allowlist from "./token-lint-allowlist.json";

/*
 * Token lint: feature code and the shared layout/shared kits pass props and layout classes only.
 * Colour, radius, type size, tracking and stacking come from theme tokens and shared components
 * (ui/src/index.css, components/ui). This scans every string in those files (class lists live in
 * strings; comments are skipped) and fails on raw colours, arbitrary visual values, palette
 * classes, per-call touch sizing, ad hoc `sticky` and native `title` tooltips.
 *
 * Offenders that predate the lint are listed in token-lint-allowlist.json with a reason. An
 * entry that no longer matches anything fails too, so the list only shrinks.
 */

const sources = import.meta.glob<string>(
  [
    "/src/features/**/*.{ts,tsx}",
    "/src/components/layout/**/*.{ts,tsx}",
    "/src/components/shared/**/*.{ts,tsx}",
  ],
  { eager: true, query: "?raw", import: "default" },
);

// Tests and dev-only fixtures, plus content art whose colours are the artwork itself.
const SKIPPED = [
  /\.test\.tsx?$/,
  /^src\/features\/[^/]+\/mocks\.ts$/,
  /\/auth-showcase\.tsx$/,
  /\/flag-icon\.tsx$/,
  /\/model-logos?\.tsx$/,
  /\/brand-logos\.tsx$/,
];

// Places that own a sticky layer by design: DataTable's pinned columns, the site header, the
// Settings section nav and the Accounts batch toolbar.
const STICKY_OWNERS = [
  /^src\/components\/shared\/data-table\.tsx$/,
  /^src\/components\/layout\/site-header\.tsx$/,
  /^src\/features\/settings\/settings-page\.tsx$/,
  /^src\/features\/accounts\/batch-bar\.tsx$/,
];

// DataTable stacks its pinned cells and their edge shadow with z-[1] / z-[2].
const Z_OWNERS = [/^src\/components\/shared\/data-table\.tsx$/];

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOUR_UTILITY =
  "bg|text|border(?:-[trblxyse])?|fill|stroke|ring|outline|from|via|to|decoration|divide|shadow|accent|caret|placeholder";

interface Rule {
  id: string;
  pattern: RegExp;
  exempt?: RegExp[];
}

const RULES: readonly Rule[] = [
  { id: "hex", pattern: /(?<![\w&#])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])/gi },
  { id: "colour-function", pattern: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/g },
  { id: "arbitrary-text", pattern: /(?<![\w-])text-\[[^\]]*\]/g },
  { id: "arbitrary-bg", pattern: /(?<![\w-])bg-\[[^\]]*\]/g },
  { id: "arbitrary-radius", pattern: /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[[^\]]*\]/g },
  { id: "arbitrary-tracking", pattern: /(?<![\w-])tracking-\[[^\]]*\]/g },
  { id: "arbitrary-z", pattern: /(?<![\w])-?z-\[[^\]]*\]/g, exempt: Z_OWNERS },
  {
    id: "palette",
    pattern: new RegExp(
      `(?<![\\w-])(?:${COLOUR_UTILITY})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?:\\/[\\d.]+)?(?![\\w-])`,
      "g",
    ),
  },
  { id: "sticky", pattern: /(?<![\w-])sticky(?![\w-])/g, exempt: STICKY_OWNERS },
  {
    id: "touch-sizing",
    pattern: /\bsize-10\b.*\bmd:size-8\b|\bh-10\b.*\bsm:h-8\b|\bmax-md:size-10\b|\bmax-md:h-10\b/g,
  },
];

// SVG elements keep `title`-free markup by other means; their names are lowercase too.
const SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "use",
  "symbol",
  "clipPath",
  "mask",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "foreignObject",
]);

interface Offence {
  file: string;
  line: number;
  rule: string;
  match: string;
}

/** Every string in the file (literals and template parts), and native `title` attributes. */
function lintSource(code: string, file: string): Offence[] {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const offences: Offence[] = [];
  const check = (text: string, line: number) => {
    for (const rule of RULES) {
      if (rule.exempt?.some((pattern) => pattern.test(file))) continue;
      for (const found of text.matchAll(rule.pattern)) {
        offences.push({ file, line, rule: rule.id, match: found[0].slice(0, 80) });
      }
    }
  };
  const walk = (node: unknown): void => {
    if (!isAstNode(node)) return;
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") return;
    const line = node.loc?.start.line ?? 0;
    if (isNode(node, "StringLiteral")) check(node.value, line);
    else if (isNode(node, "TemplateElement")) check(node.value.cooked ?? node.value.raw, line);
    else if (isNode(node, "JSXOpeningElement") && isNode(node.name, "JSXIdentifier")) {
      const name = node.name.name;
      if (/^[a-z]/.test(name) && !SVG_ELEMENTS.has(name)) {
        for (const attr of node.attributes) {
          if (isNode(attr, "JSXAttribute") && attr.name.name === "title") {
            offences.push({ file, line, rule: "native-title", match: `<${name} title>` });
          }
        }
      }
    }
    for (const [key, value] of fields(node)) {
      if (key === "loc" || key === "start" || key === "end" || key.endsWith("Comments")) continue;
      if (Array.isArray(value)) for (const child of value) walk(child);
      else walk(value);
    }
  };
  walk(ast.program);
  return offences;
}

interface AllowlistEntry {
  file: string;
  rule: string;
  match: string;
  reason: string;
}

const entries = allowlist as AllowlistEntry[];
const same = (offence: Offence, entry: AllowlistEntry) =>
  offence.file === entry.file && offence.rule === entry.rule && offence.match === entry.match;

const files = Object.entries(sources)
  .map(([path, code]) => [path.replace(/^\//, ""), code] as const)
  .filter(([file]) => !SKIPPED.some((pattern) => pattern.test(file)));
const offences = files.flatMap(([file, code]) => lintSource(code, file));

describe("token lint", () => {
  it("scans features and the layout and shared kits", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(files.some(([file]) => file.startsWith("src/components/layout/"))).toBe(true);
    expect(files.some(([file]) => file.startsWith("src/components/shared/"))).toBe(true);
  });

  it("finds no raw colours, arbitrary visual values, palette classes or native titles", () => {
    const fresh = offences
      .filter((offence) => !entries.some((entry) => same(offence, entry)))
      .map((offence) => `${offence.file}:${offence.line} [${offence.rule}] ${offence.match}`);
    expect(fresh, "use a theme token or a shared component, or allowlist with a reason").toEqual(
      [],
    );
  });

  it("gives every allowlist entry a one-line reason", () => {
    const bad = entries.filter(
      (entry) =>
        typeof entry.reason !== "string" || !entry.reason.trim() || /\n/.test(entry.reason),
    );
    expect(bad).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stale = entries.filter((entry) => !offences.some((offence) => same(offence, entry)));
    expect(stale).toEqual([]);
  });
});

describe("lintSource", () => {
  const lint = (code: string) =>
    lintSource(code, "src/features/x/fixture.tsx").map((o) => `${o.rule}: ${o.match}`);

  it("flags raw colours, arbitrary values, palette classes, touch sizing and native titles", () => {
    expect(
      lint(`
        const a = "#09090a";
        const b = \`color-mix(in oklab, oklch(0.5 0 0) 40%, rgb(0 0 0))\`;
        export function A() {
          return (
            <div
              className="text-[13px] bg-[var(--x)] rounded-[20px] tracking-[0.01em] z-[5] sticky"
              title="Hidden note"
            >
              <span className="bg-red-600 text-white/70 border-zinc-200 size-10 md:size-8" />
              <svg><title>Chart</title><rect title="x" /></svg>
            </div>
          );
        }
      `),
    ).toEqual([
      "hex: #09090a",
      "colour-function: oklch(",
      "colour-function: rgb(",
      "native-title: <div title>",
      "arbitrary-text: text-[13px]",
      "arbitrary-bg: bg-[var(--x)]",
      "arbitrary-radius: rounded-[20px]",
      "arbitrary-tracking: tracking-[0.01em]",
      "arbitrary-z: z-[5]",
      "sticky: sticky",
      "palette: bg-red-600",
      "palette: text-white/70",
      "palette: border-zinc-200",
      "touch-sizing: size-10 md:size-8",
    ]);
  });

  it("allows tokens, layout values, anchors, comments and component title props", () => {
    expect(
      lint(`
        // A comment may say #000 or rgb(0 0 0) or sticky.
        const href = "#settings-usage";
        const grid = "grid-cols-[minmax(0,1fr)_auto] text-meta bg-surface-2 rounded-xl z-30";
        export function A() {
          return <SectionCard className="text-muted-foreground bg-card" title="Keys" />;
        }
      `),
    ).toEqual([]);
  });
});
