import { redirect } from "@tanstack/react-router";
import {
  findSection,
  SETTINGS_PAGE_PATH,
  type SettingsPageId,
  sectionPage,
} from "../sections/sections";

/**
 * A link to a card that sits on another Settings page (an old /settings#settings-alerts from
 * before the page was split, or a hand-edited URL) goes to that page, hash kept.
 */
export function redirectToSectionPage(page: SettingsPageId, hash: string): void {
  const section = findSection(hash);
  if (!section) return;
  const target = sectionPage(section);
  if (target !== page) throw redirect({ to: SETTINGS_PAGE_PATH[target], hash: section.id });
}
