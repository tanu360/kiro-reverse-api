/** Every locale file, as lib/i18n loads them: catalog[namespace][lang] is a flat dictionary. */

export type Dict = Record<string, string>;

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

export const catalog: Record<string, Partial<Record<string, Dict>>> = {};
for (const [modules, namespaceOf] of sources) {
  for (const [path, dict] of Object.entries(modules)) {
    const segments = path.split("/");
    const lang = segments[segments.length - 1].replace(/\.json$/, "");
    const ns = namespaceOf(segments);
    catalog[ns] = { ...catalog[ns], [lang]: dict };
  }
}

export const namespaces = Object.keys(catalog).sort();

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** The key without its plural suffix. */
export function baseKey(key: string): string {
  return key.replace(PLURAL, "");
}

/** The plural category a key ends with, if any. */
export function pluralSuffix(key: string): string | undefined {
  return PLURAL.exec(key)?.[1];
}
