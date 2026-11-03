import { describe, expect, it } from "vitest";
import { intlLocale, LANGS, pluralCategory, type SupportedLang } from "@/lib/i18n";

type Dict = Record<string, string>;

// The same three globs lib/i18n loads, keyed by namespace.
const sources: [Record<string, Dict>, (segments: string[]) => string][] = [
  [
    import.meta.glob<Dict>("/src/locales/*.json", { eager: true, import: "default" }),
    () => "common",
  ],
  [
    import.meta.glob<Dict>("/src/locales/*/*.json", { eager: true, import: "default" }),
    (segments) => segments[segments.length - 2],
  ],
  [
    import.meta.glob<Dict>("/src/features/*/locales/*.json", { eager: true, import: "default" }),
    (segments) => segments[segments.length - 3],
  ],
];

const catalog: Record<string, Partial<Record<string, Dict>>> = {};
for (const [modules, namespaceOf] of sources) {
  for (const [path, dict] of Object.entries(modules)) {
    const segments = path.split("/");
    const lang = segments[segments.length - 1].replace(/\.json$/, "");
    const ns = namespaceOf(segments);
    catalog[ns] = { ...catalog[ns], [lang]: dict };
  }
}

const namespaces = Object.keys(catalog).sort();
const PLURAL = /_(zero|one|two|few|many|other)$/;

function base(key: string): string {
  return key.replace(PLURAL, "");
}

function suffix(key: string): string | undefined {
  return PLURAL.exec(key)?.[1];
}

function baseKeys(dict: Dict): string[] {
  return [...new Set(Object.keys(dict).map(base))].sort();
}

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(",");
}

/** Categories Intl selects for whole counts 0..1000 (what the UI passes as `count`). */
function requiredCategories(lang: SupportedLang): Set<string> {
  const categories = new Set<string>();
  for (let count = 0; count <= 1000; count += 1) categories.add(pluralCategory(lang, count));
  return categories;
}

function allowedCategories(lang: SupportedLang): Set<string> {
  return new Set(new Intl.PluralRules(intlLocale(lang)).resolvedOptions().pluralCategories);
}

describe("locale parity", () => {
  it("ships the four languages", () => {
    expect([...LANGS]).toEqual(["en", "zh", "vi", "pt-BR"]);
  });

  it("loads common, errors, ui and all eight feature namespaces in every language", () => {
    for (const ns of [
      "common",
      "errors",
      "ui",
      "overview",
      "accounts",
      "add-account",
      "requests",
      "api",
      "settings",
      "backups",
      "auth",
    ]) {
      for (const lang of LANGS) expect(catalog[ns]?.[lang], `${ns} ${lang}`).toBeDefined();
    }
  });

  it("has no locale file for an unsupported language", () => {
    const extra = namespaces.flatMap((ns) =>
      Object.keys(catalog[ns]).filter((lang) => !(LANGS as readonly string[]).includes(lang)),
    );
    expect(extra).toEqual([]);
  });

  describe.each(namespaces)("%s", (ns) => {
    const en = catalog[ns].en ?? {};

    it.each(LANGS.filter((lang) => lang !== "en"))("has the same keys in %s as in en", (lang) => {
      expect(baseKeys(catalog[ns][lang] ?? {})).toEqual(baseKeys(en));
    });

    it.each(LANGS)("uses the same {placeholders} as en in %s", (lang) => {
      const dict = catalog[ns][lang] ?? {};
      const mismatched: string[] = [];
      for (const [key, text] of Object.entries(dict)) {
        const source = en[key] ?? en[`${base(key)}_other`] ?? en[base(key)];
        if (source === undefined) continue;
        if (placeholders(text) !== placeholders(source)) mismatched.push(key);
      }
      // Every plural form of one key uses the same placeholders.
      for (const key of Object.keys(dict)) {
        const other = dict[`${base(key)}_other`];
        if (suffix(key) && other !== undefined && placeholders(dict[key]) !== placeholders(other)) {
          mismatched.push(key);
        }
      }
      expect([...new Set(mismatched)]).toEqual([]);
    });

    it.each(LANGS)("has no empty strings and no positional placeholders in %s", (lang) => {
      const bad: string[] = [];
      for (const [key, text] of Object.entries(catalog[ns][lang] ?? {})) {
        if (typeof text !== "string" || text.trim() === "") bad.push(`${key} empty`);
        else if (/\{\d+\}/.test(text)) bad.push(`${key} positional`);
      }
      expect(bad).toEqual([]);
    });

    it.each(LANGS)("has valid plural forms in %s", (lang) => {
      const dict = catalog[ns][lang] ?? {};
      const required = requiredCategories(lang);
      const allowed = allowedCategories(lang);
      const bad: string[] = [];
      const pluralBases = new Set(Object.keys(dict).filter(suffix).map(base));
      for (const key of Object.keys(dict)) {
        const category = suffix(key);
        if (category && !allowed.has(category)) bad.push(`${key}: no "${category}" form`);
        if (category && base(key) in dict) bad.push(`${key}: also has a plain ${base(key)}`);
      }
      for (const name of pluralBases) {
        for (const category of required) {
          if (!(`${name}_${category}` in dict)) bad.push(`${name}_${category} missing`);
        }
      }
      // A key that is plural in English needs every form this language distinguishes.
      if (required.size > 1) {
        for (const name of new Set(Object.keys(en).filter(suffix).map(base))) {
          if (!pluralBases.has(name)) bad.push(`${name}: plural in en, not in ${lang}`);
        }
      }
      expect(bad).toEqual([]);
    });
  });
});
