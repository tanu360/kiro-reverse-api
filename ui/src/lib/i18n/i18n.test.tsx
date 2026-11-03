import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getInitialLang,
  I18nProvider,
  intlLocale,
  LANG_STORAGE_KEY,
  LANGS,
  LANGUAGES,
  matchLang,
  PSEUDO_ENABLED,
  PSEUDO_LANG,
  pluralCategory,
  registerMessages,
  translate,
  useLanguage,
  useT,
} from "./index";

// Fixture namespaces only: these tests must not depend on other features' locale files.
beforeAll(() => {
  registerMessages("en", "fixture", {
    greeting: "Hello {name}",
    items_one: "{count} item",
    items_other: "{count} items",
    onlyEnglish: "English only",
    keep: "Keep {unknown}",
  });
  registerMessages("zh", "fixture", {
    greeting: "你好 {name}",
    items_other: "{count} 项",
  });
  registerMessages("en", "fixture-other", { title: "Other namespace" });
  registerMessages("zh", "fixture-other", { title: "其他命名空间" });
});

describe("translate", () => {
  it("looks a key up in its namespace and interpolates {name}", () => {
    expect(translate("en", "fixture", "greeting", { name: "Ada" })).toBe("Hello Ada");
    expect(translate("zh", "fixture", "greeting", { name: "Ada" })).toBe("你好 Ada");
  });

  it("crosses namespaces with ns:key", () => {
    expect(translate("en", "fixture", "fixture-other:title")).toBe("Other namespace");
    expect(translate("zh", "fixture", "fixture-other:title")).toBe("其他命名空间");
  });

  it("falls back to English, then to the key", () => {
    expect(translate("zh", "fixture", "onlyEnglish")).toBe("English only");
    expect(translate("en", "fixture", "missing.key")).toBe("missing.key");
    expect(translate("en", "fixture", "nowhere:missing")).toBe("nowhere:missing");
  });

  it("leaves unknown placeholders alone", () => {
    expect(translate("en", "fixture", "keep", { name: "x" })).toBe("Keep {unknown}");
  });

  it("selects _one/_other in English and _other in Chinese", () => {
    expect(translate("en", "fixture", "items", { count: 1 })).toBe("1 item");
    expect(translate("en", "fixture", "items", { count: 3 })).toBe("3 items");
    expect(translate("en", "fixture", "items", { count: 0 })).toBe("0 items");
    expect(translate("zh", "fixture", "items", { count: 1 })).toBe("1 项");
    expect(translate("zh", "fixture", "items", { count: 5 })).toBe("5 项");
  });

  it("merges repeated registrations", () => {
    registerMessages("en", "fixture-merge", { a: "A" });
    registerMessages("en", "fixture-merge", { b: "B" });
    expect(translate("en", "fixture-merge", "a")).toBe("A");
    expect(translate("en", "fixture-merge", "b")).toBe("B");
  });
});

function Greeting() {
  const { t, lang } = useT("fixture");
  const { setLang } = useLanguage();
  return (
    <div>
      <p data-testid="text">{t("greeting", { name: "Ada" })}</p>
      <p data-testid="lang">{lang}</p>
      <button type="button" onClick={() => setLang("zh")}>
        zh
      </button>
    </div>
  );
}

function Common() {
  return <p>{useT().t("fixture.commonKey")}</p>;
}

function Switcher() {
  const { setLang } = useLanguage();
  return (
    <>
      {LANGUAGES.map((option) => (
        <button key={option.code} onClick={() => setLang(option.code)} type="button">
          {option.code}
        </button>
      ))}
    </>
  );
}

describe("I18nProvider", () => {
  it("renders with the initial language and switches with setLang", async () => {
    render(
      <I18nProvider initialLang="en">
        <Greeting />
      </I18nProvider>,
    );
    expect(screen.getByTestId("text")).toHaveTextContent("Hello Ada");
    expect(document.documentElement.lang).toBe("en");

    await userEvent.click(screen.getByRole("button", { name: "zh" }));
    expect(screen.getByTestId("text")).toHaveTextContent("你好 Ada");
    expect(screen.getByTestId("lang")).toHaveTextContent("zh");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("zh");
    expect(document.documentElement.lang).toBe("zh");
  });

  it("sets <html lang> for every language", async () => {
    render(
      <I18nProvider initialLang="en">
        <Switcher />
      </I18nProvider>,
    );
    for (const option of LANGUAGES) {
      await userEvent.click(screen.getByRole("button", { name: option.code }));
      expect(document.documentElement.lang).toBe(option.code);
      expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe(option.code);
    }
  });

  it("defaults to the common namespace", () => {
    registerMessages("en", "common", { "fixture.commonKey": "From common" });
    render(
      <I18nProvider initialLang="en">
        <Common />
      </I18nProvider>,
    );
    expect(screen.getByText("From common")).toBeInTheDocument();
  });
});

describe("getInitialLang", () => {
  it("prefers the stored language", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "zh");
    expect(getInitialLang()).toBe("zh");
  });

  it.each([
    [["zh-CN"], "zh"],
    [["zh-TW", "en"], "zh"],
    [["vi-VN"], "vi"],
    [["vi"], "vi"],
    [["pt-PT"], "pt-BR"],
    [["pt-BR", "en-US"], "pt-BR"],
    [["en-GB"], "en"],
    [["fr-FR", "vi-VN"], "vi"],
  ])("maps navigator.languages %j to %s", (languages, expected) => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
    expect(getInitialLang()).toBe(expected);
  });

  it("falls back to English and ignores unknown stored values", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "fr");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    expect(getInitialLang()).toBe("en");
  });

  it("restores every supported stored language", () => {
    for (const lang of LANGS) {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
      expect(getInitialLang()).toBe(lang);
    }
  });
});

describe("matchLang", () => {
  it("maps zh*, vi*, pt* and en* and nothing else", () => {
    expect(matchLang("zh-Hans-CN")).toBe("zh");
    expect(matchLang("VI")).toBe("vi");
    expect(matchLang("pt")).toBe("pt-BR");
    expect(matchLang("en-AU")).toBe("en");
    expect(matchLang("de")).toBeUndefined();
  });
});

describe("plural selection", () => {
  beforeAll(() => {
    registerMessages("en", "fixture-plural", {
      n_one: "{count} account",
      n_other: "{count} accounts",
    });
    registerMessages("pt-BR", "fixture-plural", {
      n_one: "{count} conta",
      n_other: "{count} contas",
    });
    registerMessages("vi", "fixture-plural", { n_other: "{count} tài khoản" });
  });

  it("follows CLDR through Intl.PluralRules, with pt-BR 0 as other", () => {
    expect(pluralCategory("en", 0)).toBe("other");
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("pt-BR", 0)).toBe("other");
    expect(pluralCategory("pt-BR", 1)).toBe("one");
    expect(pluralCategory("pt-BR", 2)).toBe("other");
    expect(pluralCategory("vi", 1)).toBe("other");
    expect(pluralCategory("zh", 1)).toBe("other");
    expect(translate("pt-BR", "fixture-plural", "n", { count: 0 })).toBe("0 contas");
    expect(translate("pt-BR", "fixture-plural", "n", { count: 1 })).toBe("1 conta");
    expect(translate("pt-BR", "fixture-plural", "n", { count: 5 })).toBe("5 contas");
    expect(translate("vi", "fixture-plural", "n", { count: 1 })).toBe("1 tài khoản");
  });

  it("falls back to English for a key missing in the language", () => {
    expect(translate("vi", "fixture", "onlyEnglish")).toBe("English only");
    expect(translate("pt-BR", "fixture", "onlyEnglish")).toBe("English only");
  });
});

describe("pseudo language", () => {
  it("wraps every translated string in markers in tests and dev", () => {
    expect(PSEUDO_ENABLED).toBe(true);
    expect(translate(PSEUDO_LANG, "fixture", "greeting", { name: "Ada" })).toBe("⟦Hello Ada⟧");
    // A missing key is not translated, so it stays unwrapped and the e2e check flags it.
    expect(translate(PSEUDO_LANG, "fixture", "missing.key")).toBe("missing.key");
  });

  it("is not a selectable language and formats like English", () => {
    expect(LANGS).not.toContain(PSEUDO_LANG);
    expect(intlLocale(PSEUDO_LANG)).toBe("en-US");
  });
});
