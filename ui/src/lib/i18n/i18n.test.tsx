import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getInitialLang,
  I18nProvider,
  LANG_STORAGE_KEY,
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

  it("uses navigator.language zh-CN when nothing is stored", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    expect(getInitialLang()).toBe("zh");
  });

  it("falls back to English and ignores unknown stored values", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "fr");
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    expect(getInitialLang()).toBe("en");
  });
});
