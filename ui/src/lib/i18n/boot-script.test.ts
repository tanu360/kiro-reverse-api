import { afterEach, describe, expect, it, vi } from "vitest";
import html from "../../../index.html?raw";
import { getInitialLang, LANG_STORAGE_KEY, LANGS, PSEUDO_LANG } from "./index";

// The pre-paint script in index.html sets <html lang> before React loads. It cannot import the
// i18n module, so it repeats getInitialLang; these cases keep the two copies in step.
const bootSource = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];

function runBootScript(): string {
  if (!bootSource) throw new Error("index.html has no inline boot script");
  document.documentElement.lang = "";
  new Function(bootSource)();
  return document.documentElement.lang;
}

/** The document language the app sets once React mounts. */
function appDocumentLang(): string {
  const lang = getInitialLang();
  return lang === PSEUDO_LANG ? "en" : lang;
}

afterEach(() => {
  localStorage.clear();
  // The script also applies the theme; undo that too.
  document.documentElement.lang = "en";
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

describe("index.html boot script", () => {
  it.each(LANGS)("keeps the stored language %s", (lang) => {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
    expect(runBootScript()).toBe(lang);
    expect(runBootScript()).toBe(appDocumentLang());
  });

  it.each([
    [["vi-VN"], "vi"],
    [["pt-PT"], "pt-BR"],
    [["pt-BR", "en-US"], "pt-BR"],
    [["zh-TW", "en"], "zh"],
    [["fr-FR", "vi-VN"], "vi"],
    [["de-DE"], "en"],
  ])("maps navigator.languages %j to %s like getInitialLang", (languages, expected) => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
    expect(runBootScript()).toBe(expected);
    expect(runBootScript()).toBe(appDocumentLang());
  });

  it("falls back to navigator.language when navigator.languages is empty", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue([]);
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-BR");
    expect(runBootScript()).toBe("pt-BR");
    expect(runBootScript()).toBe(appDocumentLang());
  });

  it("ignores an unknown stored value and detects instead", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "fr");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["vi"]);
    expect(runBootScript()).toBe("vi");
    expect(runBootScript()).toBe(appDocumentLang());
  });

  it("renders the stored pseudo language as English", () => {
    localStorage.setItem(LANG_STORAGE_KEY, PSEUDO_LANG);
    expect(runBootScript()).toBe("en");
  });
});
