import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { type AstNode, fields, isAstNode, isNode, type NodeOf } from "./babel-ast";
import { baseKey, catalog, namespaces } from "./locale-catalog";

// Every `t("key")` in the source must name a key that exists, and every English key must be used
// somewhere. A renamed key fails here even though `pnpm typecheck` cannot see it.

const sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

// Not shipped UI code: tests and their helpers, MSW fixtures and the generated route tree.
const SKIPPED = [
  /\.test\.tsx?$/,
  /^src\/test\//,
  /^src\/lib\/mocks\//,
  /^src\/features\/[^/]+\/mocks\.ts$/,
  /^src\/routeTree\.gen\.ts$/,
];

const NAMESPACED = /^([A-Za-z][\w-]*):(.+)$/;
const DEFAULT_NAMESPACE = "common";
const UI_NAMESPACE = "ui";

interface KeyUse {
  file: string;
  line: number;
  /** A literal key, or a pattern built from a template literal (each `${…}` matches a segment). */
  key: string | RegExp;
}

interface FileScan {
  /** Namespaces from `useT("ns")` calls; `useT()` is common. */
  namespaces: Set<string>;
  uses: KeyUse[];
  /** Every string literal, for keys that are stored in tables before they reach t(). */
  literals: Set<string>;
}

function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (!isAstNode(value)) return;
  visit(value);
  for (const [field, child] of fields(value)) {
    if (field === "loc" || field === "start" || field === "end") continue;
    if (Array.isArray(child)) for (const item of child) walk(item, visit);
    else walk(child, visit);
  }
}

function templatePattern(node: NodeOf<"TemplateLiteral">): RegExp {
  const parts = node.quasis.map((quasi) =>
    (quasi.value.cooked ?? quasi.value.raw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^${parts.join("[\\w.-]+")}$`);
}

function scanFile(code: string, file: string): FileScan {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const scan: FileScan = { namespaces: new Set(), uses: [], literals: new Set() };
  walk(ast.program, (node) => {
    if (isNode(node, "StringLiteral")) scan.literals.add(node.value);
    if (!isNode(node, "CallExpression") || !isNode(node.callee, "Identifier")) return;
    const callee = node.callee.name;
    const [arg] = node.arguments;
    if (callee === "useT") {
      scan.namespaces.add(isNode(arg, "StringLiteral") ? arg.value : DEFAULT_NAMESPACE);
    } else if (callee === "useUiT") {
      // components/ui/messages.ts: useT bound to the primitives' own namespace.
      scan.namespaces.add(UI_NAMESPACE);
    } else if (callee === "t" && arg) {
      const line = node.loc?.start.line ?? 0;
      if (isNode(arg, "StringLiteral")) scan.uses.push({ file, line, key: arg.value });
      else if (isNode(arg, "TemplateLiteral") && arg.expressions.length > 0) {
        scan.uses.push({ file, line, key: templatePattern(arg) });
      }
    }
  });
  return scan;
}

const scans = Object.entries(sources).flatMap(([path, code]) => {
  const file = path.replace(/^\//, "");
  return SKIPPED.some((pattern) => pattern.test(file)) ? [] : [scanFile(code, file)];
});

const enKeys = new Map(
  namespaces.map((ns) => [ns, new Set(Object.keys(catalog[ns].en ?? {}).map(baseKey))]),
);
// Full keys with their plural suffix, for code that picks a plural form itself.
const enFullKeys = new Map(namespaces.map((ns) => [ns, Object.keys(catalog[ns].en ?? {})]));

function matches(ns: string, key: string | RegExp): boolean {
  const keys = enKeys.get(ns);
  if (!keys) return false;
  if (typeof key === "string") return keys.has(key);
  return [...keys].some((name) => key.test(name));
}

describe("locale key usage", () => {
  it("scans the source tree", () => {
    expect(scans.length).toBeGreaterThan(150);
    expect(scans.some((scan) => scan.uses.length > 0)).toBe(true);
  });

  it("calls t() only with keys that exist in English", () => {
    const missing: string[] = [];
    for (const scan of scans) {
      for (const use of scan.uses) {
        const raw = typeof use.key === "string" ? use.key : use.key.source;
        const named = typeof use.key === "string" ? NAMESPACED.exec(use.key) : null;
        if (named) {
          if (!matches(named[1], named[2])) missing.push(`${use.file}:${use.line} ${raw}`);
          continue;
        }
        if (use.key instanceof RegExp && use.key.source.startsWith("^[\\w.-]+")) continue;
        // A file without useT() gets `t` from its caller, so any namespace may own the key.
        const candidates = scan.namespaces.size > 0 ? [...scan.namespaces] : namespaces;
        if (!candidates.some((ns) => matches(ns, use.key))) {
          missing.push(`${use.file}:${use.line} ${raw}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("uses every English key", () => {
    const literals = new Set(scans.flatMap((scan) => [...scan.literals]));
    const patterns = scans.flatMap((scan) =>
      scan.uses.flatMap((use) => (use.key instanceof RegExp ? [use.key] : [])),
    );
    const unused: string[] = [];
    for (const [ns, keys] of enKeys) {
      for (const key of keys) {
        const qualified = `${ns}:${key}`;
        if (literals.has(key) || literals.has(qualified)) continue;
        const forms = (enFullKeys.get(ns) ?? []).filter((full) => baseKey(full) === key);
        if (forms.some((full) => literals.has(full) || literals.has(`${ns}:${full}`))) continue;
        if (patterns.some((pattern) => pattern.test(key) || pattern.test(qualified))) continue;
        unused.push(qualified);
      }
    }
    expect(unused).toEqual([]);
  });
});
