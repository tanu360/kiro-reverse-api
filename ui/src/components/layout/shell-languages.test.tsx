import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LANGUAGES, type SupportedLang } from "@/lib/i18n";
import en from "@/locales/en.json";
import ptBR from "@/locales/pt-BR.json";
import vi from "@/locales/vi.json";
import zh from "@/locales/zh.json";
import { renderApp } from "@/test/render";
import { NAV_ITEMS } from "./nav-items";

const COMMON: Record<SupportedLang, Record<string, string>> = { en, zh, vi, "pt-BR": ptBR };

// The shell (sidebar, header, document title) in each shipped language.
describe.each(LANGUAGES.map((option) => option.code))("app shell in %s", (lang) => {
  const text = COMMON[lang];

  it("translates the navigation and sets <html lang>", async () => {
    await renderApp("/backups", { lang });
    const nav = await screen.findByRole("navigation", { name: text["shell.navigation"] });
    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: text[item.labelKey] })).toBeInTheDocument();
    }
    expect(within(nav).getByText(text["nav.group.monitor"])).toBeInTheDocument();
    expect(document.documentElement.lang).toBe(lang);
    await waitFor(() =>
      expect(document.title).toBe(
        text["shell.documentTitle"].replace("{page}", text["nav.backups"]),
      ),
    );
    if (lang !== "en") {
      // Translated, not the English fallback.
      expect(text["nav.settings"]).not.toBe(en["nav.settings"]);
    }
  });

  it("lists the four languages by native name with the current one checked", async () => {
    const { user } = await renderApp("/backups", { lang });
    const header = await screen.findByRole("banner");
    await user.click(within(header).getByRole("button", { name: text["shell.language"] }));
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(
      LANGUAGES.map((option) => option.nativeLabel),
    );
    const current = LANGUAGES.findIndex((option) => option.code === lang);
    items.forEach((item, index) => {
      expect(item).toHaveAttribute("aria-checked", String(index === current));
      expect(item).toHaveAttribute("lang", LANGUAGES[index].code);
    });
  });
});

describe("language menu", () => {
  it("switches the whole shell and persists the choice", async () => {
    const { user } = await renderApp("/backups", { lang: "en" });
    const header = await screen.findByRole("banner");
    await user.click(within(header).getByRole("button", { name: en["shell.language"] }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Tiếng Việt" }));
    expect(
      await screen.findByRole("navigation", { name: vi["shell.navigation"] }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("vi");
    expect(localStorage.getItem("kiro_lang")).toBe("vi");
  });
});
