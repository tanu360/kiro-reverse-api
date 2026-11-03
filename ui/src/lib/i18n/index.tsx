import type { JSX, ReactNode } from "react";

export type Lang = "en" | "zh";
export const LANGS: readonly Lang[] = ["en", "zh"];
export const LANG_STORAGE_KEY = "kiro_lang";

export type TParams = Record<string, string | number>;
export type TFunction = (key: string, params?: TParams) => string;

// Skeleton: Task 3 implements the catalog, namespaces and language persistence.

const identity: TFunction = (key) => key;

export function I18nProvider(props: { children: ReactNode; initialLang?: Lang }): JSX.Element {
  return <>{props.children}</>;
}

export function useT(_namespace?: string): { t: TFunction; lang: Lang } {
  return { t: identity, lang: "en" };
}

export function useLanguage(): { lang: Lang; setLang: (lang: Lang) => void } {
  return { lang: "en", setLang() {} };
}

export function translate(_lang: Lang, _namespace: string, key: string, _params?: TParams): string {
  return key;
}

/** Merges a dictionary into the catalog. The glob loader uses it; tests register fixtures. */
export function registerMessages(
  _lang: Lang,
  _namespace: string,
  _dict: Record<string, string>,
): void {}

export function getInitialLang(): Lang {
  return "en";
}
