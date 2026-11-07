import { type Lang, type TFunction, useT } from "@/lib/i18n";

/**
 * Strings the shared primitives render themselves (accessible names, screen-reader summaries,
 * default labels) live in src/locales/ui/<lang>.json, the `ui` namespace, so a primitive never
 * ships a hardcoded English label.
 */
const UI_NAMESPACE = "ui";

/** `useT` bound to the primitives' own namespace. */
export function useUiT(): { t: TFunction; lang: Lang } {
  return useT(UI_NAMESPACE);
}
