import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { readStorage, writeStorage } from "@/lib/storage";

export type Lang = "en" | "zh";
export const LANGS: readonly Lang[] = ["en", "zh"];
export const LANG_STORAGE_KEY = "kiro_lang";

export type TParams = Record<string, string | number>;
export type TFunction = (key: string, params?: TParams) => string;

type Dict = Record<string, string>;

const DEFAULT_NAMESPACE = "common";
const catalog: Record<Lang, Record<string, Dict>> = { en: {}, zh: {} };

function isLang(value: unknown): value is Lang {
  return value === "en" || value === "zh";
}

/** Merges a flat dictionary into the catalog. The glob loader uses it; tests register fixtures. */
export function registerMessages(
  lang: Lang,
  namespace: string,
  dict: Record<string, string>,
): void {
  catalog[lang][namespace] = { ...catalog[lang][namespace], ...dict };
}

function registerGlob(
  modules: Record<string, Dict>,
  namespaceOf: (segments: string[]) => string | undefined,
): void {
  for (const [path, dict] of Object.entries(modules)) {
    const segments = path.split("/");
    const lang = segments[segments.length - 1]?.replace(/\.json$/, "");
    const namespace = namespaceOf(segments);
    if (isLang(lang) && namespace) registerMessages(lang, namespace, dict);
  }
}

// Shared strings: src/locales/<lang>.json is `common`, src/locales/<ns>/<lang>.json is `<ns>`.
// Each feature owns src/features/<feature>/locales/<lang>.json as the `<feature>` namespace.
registerGlob(
  import.meta.glob<Dict>("/src/locales/*.json", { eager: true, import: "default" }),
  () => DEFAULT_NAMESPACE,
);
registerGlob(
  import.meta.glob<Dict>("/src/locales/*/{en,zh}.json", { eager: true, import: "default" }),
  (segments) => segments[segments.length - 2],
);
registerGlob(
  import.meta.glob<Dict>("/src/features/*/locales/{en,zh}.json", {
    eager: true,
    import: "default",
  }),
  (segments) => segments[segments.length - 3],
);

const NAMESPACED_KEY = /^([A-Za-z][\w-]*):(.+)$/;
const warned = new Set<string>();

function interpolate(text: string, params?: TParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

function candidates(lang: Lang, key: string, params?: TParams): string[] {
  const count = params?.count;
  if (typeof count !== "number") return [key];
  return [`${key}_${new Intl.PluralRules(lang).select(count)}`, `${key}_other`, key];
}

/**
 * Looks `key` up in `namespace` (or in the namespace of an `ns:key`), first in `lang`, then in
 * English, then returns the key itself. A numeric `params.count` selects `key_one`/`key_other`.
 */
export function translate(lang: Lang, namespace: string, key: string, params?: TParams): string {
  const match = NAMESPACED_KEY.exec(key);
  const ns = match ? match[1] : namespace;
  const name = match ? match[2] : key;
  for (const current of lang === "en" ? (["en"] as const) : ([lang, "en"] as const)) {
    const dict = catalog[current][ns];
    if (!dict) continue;
    for (const candidate of candidates(current, name, params)) {
      const text = dict[candidate];
      if (text !== undefined) return interpolate(text, params);
    }
  }
  if (import.meta.env.DEV && import.meta.env.MODE !== "test" && !warned.has(`${ns}:${name}`)) {
    warned.add(`${ns}:${name}`);
    console.warn(`[i18n] missing key ${ns}:${name}`);
  }
  return key;
}

export function getInitialLang(): Lang {
  const stored = readStorage(LANG_STORAGE_KEY);
  if (isLang(stored)) return stored;
  const browser = typeof navigator === "undefined" ? "" : (navigator.language ?? "");
  return browser.toLowerCase().startsWith("zh") ? "zh" : "en";
}

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

const LanguageContext = createContext<LanguageContextValue>({ lang: "en", setLang() {} });

function applyDocumentLang(lang: Lang): void {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export function I18nProvider(props: { children: ReactNode; initialLang?: Lang }): JSX.Element {
  const [lang, setLangState] = useState<Lang>(() => props.initialLang ?? getInitialLang());

  useEffect(() => {
    applyDocumentLang(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    writeStorage(LANG_STORAGE_KEY, next);
    applyDocumentLang(next);
    setLangState(next);
  }, []);

  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <LanguageContext.Provider value={value}>{props.children}</LanguageContext.Provider>;
}

export function useT(namespace: string = DEFAULT_NAMESPACE): { t: TFunction; lang: Lang } {
  const { lang } = useContext(LanguageContext);
  const t = useCallback<TFunction>(
    (key, params) => translate(lang, namespace, key, params),
    [lang, namespace],
  );
  return { t, lang };
}

export function useLanguage(): { lang: Lang; setLang: (lang: Lang) => void } {
  return useContext(LanguageContext);
}
