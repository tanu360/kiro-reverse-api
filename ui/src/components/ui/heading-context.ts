import { createContext, useContext } from "react";

/**
 * The id of the nearest title a control sits under: a settings row's title, else its card's
 * title (SettingsRow and SectionCard provide it). Controls repeated on a page (Save, Learn more,
 * Increase) point aria-describedby at it, so a screen reader says which card or row each belongs
 * to without new words to translate.
 */
export const HeadingIdContext = createContext<string | undefined>(undefined);

export function useHeadingId(): string | undefined {
  return useContext(HeadingIdContext);
}
