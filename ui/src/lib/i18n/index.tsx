import {
  createContext,
  Fragment,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { readStorage, writeStorage } from "@/lib/storage";
import { keyByText } from "@/lib/utils";

/** A language the UI ships with. */
export type SupportedLang = "en" | "zh" | "vi" | "pt-BR";

/**
 * The dev/test-only pseudo language: English text wrapped in ⟦…⟧ so a test can tell translated
 * text from hardcoded text. It is never selectable in production builds (PSEUDO_ENABLED is
 * statically false there, so the branches that use it are dropped from the bundle).
 */
export const PSEUDO_LANG = "pseudo";
/** The UI language: a supported language, or the pseudo language in dev and tests. */
export type Lang = SupportedLang | typeof PSEUDO_LANG;
export const PSEUDO_ENABLED: boolean = import.meta.env.DEV || import.meta.env.MODE === "test";
const PSEUDO_OPEN = "⟦";
const PSEUDO_CLOSE = "⟧";

interface LanguageOption {
  code: SupportedLang;
  /** The language's name in its own script, shown the same whatever the UI language. */
  nativeLabel: string;
  /** A short tag for compact controls (the sign-in language button), also in its own script. */
  shortLabel: string;
  /** BCP 47 locale for Intl formatting. */
  intl: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: "en", nativeLabel: "English", shortLabel: "EN", intl: "en-US" },
  { code: "zh", nativeLabel: "中文", shortLabel: "中文", intl: "zh-CN" },
  { code: "vi", nativeLabel: "Tiếng Việt", shortLabel: "VI", intl: "vi-VN" },
  { code: "pt-BR", nativeLabel: "Português (Brasil)", shortLabel: "PT", intl: "pt-BR" },
];
export const LANGS: readonly SupportedLang[] = LANGUAGES.map((option) => option.code);
export const LANG_STORAGE_KEY = "kiro_lang";

export type TParams = Record<string, string | number>;
export type TFunction = (key: string, params?: TParams) => string;

type Dict = Record<string, string>;

const DEFAULT_NAMESPACE = "common";
const catalog: Record<SupportedLang, Record<string, Dict>> = {
  en: {},
  zh: {},
  vi: {},
  "pt-BR": {},
};

function isLang(value: unknown): value is SupportedLang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

function isUiLang(value: unknown): value is Lang {
  return isLang(value) || (PSEUDO_ENABLED && value === PSEUDO_LANG);
}

/** The Intl locale for a UI language (the pseudo language formats like English). */
export function intlLocale(lang?: Lang): string {
  return LANGUAGES.find((option) => option.code === lang)?.intl ?? "en-US";
}

/** Merges a flat dictionary into the catalog. The glob loader uses it; tests register fixtures. */
export function registerMessages(
  lang: SupportedLang,
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
  import.meta.glob<Dict>("/src/locales/*/*.json", { eager: true, import: "default" }),
  (segments) => segments[segments.length - 2],
);
registerGlob(
  import.meta.glob<Dict>("/src/features/*/locales/*.json", { eager: true, import: "default" }),
  (segments) => segments[segments.length - 3],
);

const NAMESPACED_KEY = /^([A-Za-z][\w-]*):(.+)$/;
const warned = new Set<string>();
const pluralRules = new Map<string, Intl.PluralRules>();

function interpolate(text: string, params?: TParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * The CLDR plural category for `count` in `lang`. Ruling: Brazilian Portuguese uses `other` for
 * zero ("0 contas"), although CLDR puts 0 in `one` for Portuguese.
 */
export function pluralCategory(lang: Lang, count: number): Intl.LDMLPluralRule {
  if (lang === "pt-BR" && count === 0) return "other";
  const locale = intlLocale(lang);
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

function candidates(lang: SupportedLang, key: string, params?: TParams): string[] {
  const count = params?.count;
  if (typeof count !== "number") return [key];
  return [`${key}_${pluralCategory(lang, count)}`, `${key}_other`, key];
}

function lookup(
  lang: SupportedLang,
  ns: string,
  name: string,
  params?: TParams,
): string | undefined {
  for (const current of lang === "en" ? (["en"] as const) : ([lang, "en"] as const)) {
    const dict = catalog[current][ns];
    if (!dict) continue;
    for (const candidate of candidates(current, name, params)) {
      const text = dict[candidate];
      if (text !== undefined) return interpolate(text, params);
    }
  }
  return undefined;
}

/**
 * Looks `key` up in `namespace` (or in the namespace of an `ns:key`), first in `lang`, then in
 * English, then returns the key itself. A numeric `params.count` selects the CLDR plural form
 * (`key_one`, `key_few`, …), then `key_other`, then `key`.
 */
export function translate(lang: Lang, namespace: string, key: string, params?: TParams): string {
  const match = NAMESPACED_KEY.exec(key);
  const ns = match ? match[1] : namespace;
  const name = match ? match[2] : key;
  const pseudo = PSEUDO_ENABLED && lang === PSEUDO_LANG;
  const text = lookup(pseudo ? "en" : (lang as SupportedLang), ns, name, params);
  if (text !== undefined) return pseudo ? `${PSEUDO_OPEN}${text}${PSEUDO_CLOSE}` : text;
  if (import.meta.env.DEV && import.meta.env.MODE !== "test" && !warned.has(`${ns}:${name}`)) {
    warned.add(`${ns}:${name}`);
    console.warn(`[i18n] missing key ${ns}:${name}`);
  }
  return key;
}

/** Maps a BCP 47 tag to a supported language: zh* → zh, vi* → vi, pt* → pt-BR, en* → en. */
export function matchLang(tag: string): SupportedLang | undefined {
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("vi")) return "vi";
  if (lower.startsWith("pt")) return "pt-BR";
  if (lower.startsWith("en")) return "en";
  return undefined;
}

/** The stored language, else the first supported one in navigator.languages, else English. */
export function getInitialLang(): Lang {
  const stored = readStorage(LANG_STORAGE_KEY);
  if (isUiLang(stored)) return stored;
  if (typeof navigator === "undefined") return "en";
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
  for (const tag of preferred) {
    const lang = matchLang(tag ?? "");
    if (lang) return lang;
  }
  return "en";
}

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

const LanguageContext = createContext<LanguageContextValue>({ lang: "en", setLang() {} });

// The language of the provider rendered last, for code outside React (chart formatters).
let activeLang: Lang = "en";

/** The active UI language for code that cannot use hooks. */
export function getActiveLang(): Lang {
  return activeLang;
}

function applyDocumentLang(lang: Lang): void {
  if (typeof document !== "undefined") document.documentElement.lang = intlLang(lang);
}

/** The value for <html lang>: the language code, English for the pseudo language. */
function intlLang(lang: Lang): string {
  return isLang(lang) ? lang : "en";
}

export function I18nProvider(props: { children: ReactNode; initialLang?: Lang }): JSX.Element {
  const [lang, setLangState] = useState<Lang>(() => props.initialLang ?? getInitialLang());
  // Set during render so children rendered in this pass format with the new language.
  activeLang = lang;

  useEffect(() => {
    applyDocumentLang(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    if (!isUiLang(next)) return;
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

/**
 * Fills the `{name}` placeholders of a translated template with React nodes (code spans, a
 * bold label), so the sentence keeps each language's word order and punctuation. Pass t(key)
 * without params: the placeholders stay in the text.
 */
export function fillNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return keyByText(template.split(/(\{\w+\})/), (part) => part).map(({ key, item: part }) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const node = name !== undefined && Object.hasOwn(nodes, name) ? nodes[name] : part;
    return <Fragment key={key}>{node}</Fragment>;
  });
}

/** Messages as one line, with the language's list separator ("a; b", "a；b" in Chinese). */
export function joinList(t: TFunction, parts: readonly string[]): string {
  if (parts.length === 0) return "";
  return parts.reduce((first, second) => t("common:text.joinList", { first, second }));
}
