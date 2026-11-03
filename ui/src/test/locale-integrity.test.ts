import { describe, expect, it } from "vitest";

type Dict = Record<string, string>;

// The same three globs lib/i18n loads, keyed by namespace.
const sources: [Record<string, Dict>, (segments: string[]) => string][] = [
  [
    import.meta.glob<Dict>("/src/locales/*.json", { eager: true, import: "default" }),
    () => "common",
  ],
  [
    import.meta.glob<Dict>("/src/locales/*/{en,zh}.json", { eager: true, import: "default" }),
    (segments) => segments[segments.length - 2],
  ],
  [
    import.meta.glob<Dict>("/src/features/*/locales/{en,zh}.json", {
      eager: true,
      import: "default",
    }),
    (segments) => segments[segments.length - 3],
  ],
];

const catalog: Record<string, { en?: Dict; zh?: Dict }> = {};
for (const [modules, namespaceOf] of sources) {
  for (const [path, dict] of Object.entries(modules)) {
    const segments = path.split("/");
    const lang = segments[segments.length - 1].replace(/\.json$/, "") as "en" | "zh";
    const ns = namespaceOf(segments);
    catalog[ns] = { ...catalog[ns], [lang]: dict };
  }
}

const namespaces = Object.keys(catalog).sort();
const PLURAL = /_(zero|one|two|few|many|other)$/;

function baseKeys(dict: Dict): Set<string> {
  return new Set(Object.keys(dict).map((key) => key.replace(PLURAL, "")));
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

describe("locale integrity", () => {
  it("loads common, errors and all eight feature namespaces in both languages", () => {
    for (const ns of [
      "common",
      "errors",
      "overview",
      "accounts",
      "add-account",
      "requests",
      "api",
      "settings",
      "backups",
      "auth",
    ]) {
      expect(catalog[ns]?.en, `${ns} en`).toBeDefined();
      expect(catalog[ns]?.zh, `${ns} zh`).toBeDefined();
    }
  });

  describe.each(namespaces)("%s", (ns) => {
    const en = catalog[ns].en ?? {};
    const zh = catalog[ns].zh ?? {};

    it("has the same base keys in en and zh", () => {
      expect([...baseKeys(zh)].sort()).toEqual([...baseKeys(en)].sort());
    });

    it("has the plural forms each language needs", () => {
      const missing: string[] = [];
      for (const key of Object.keys(en)) {
        if (!PLURAL.test(key)) continue;
        const base = key.replace(PLURAL, "");
        if (!(`${base}_one` in en)) missing.push(`en ${base}_one`);
        if (!(`${base}_other` in en)) missing.push(`en ${base}_other`);
        if (!(`${base}_other` in zh)) missing.push(`zh ${base}_other`);
      }
      expect([...new Set(missing)]).toEqual([]);
    });

    it("uses the same placeholders in en and zh", () => {
      const mismatched: string[] = [];
      for (const [key, text] of Object.entries(zh)) {
        const base = key.replace(PLURAL, "");
        const source = en[key] ?? en[`${base}_other`] ?? en[base];
        if (source === undefined) continue;
        if (placeholders(text).join() !== placeholders(source).join()) mismatched.push(key);
      }
      expect(mismatched).toEqual([]);
    });

    it("has no empty strings and no positional placeholders", () => {
      const bad: string[] = [];
      for (const [lang, dict] of [
        ["en", en],
        ["zh", zh],
      ] as const) {
        for (const [key, text] of Object.entries(dict)) {
          if (typeof text !== "string" || text.trim() === "") bad.push(`${lang} ${key} empty`);
          else if (/\{\d+\}/.test(text)) bad.push(`${lang} ${key} positional`);
        }
      }
      expect(bad).toEqual([]);
    });
  });
});
