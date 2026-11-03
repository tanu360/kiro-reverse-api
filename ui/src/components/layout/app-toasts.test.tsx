import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, useLanguage } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { AppToastProvider, toastPosition } from "./app-toasts";

function LanguageButton(): JSX.Element {
  const { lang, setLang } = useLanguage();
  return (
    <button onClick={() => setLang(lang === "en" ? "zh" : "en")} type="button">
      switch
    </button>
  );
}

function renderToasts(lang: "en" | "zh" = "en") {
  return render(
    <I18nProvider initialLang={lang}>
      <AppToastProvider>
        <LanguageButton />
      </AppToastProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  act(() => toast.dismiss());
});

describe("toastPosition", () => {
  it("puts toasts at the top on phones, clear of bottom drawers", () => {
    expect(toastPosition(true)).toBe("top-center");
    expect(toastPosition(false)).toBe("bottom-right");
  });
});

describe("AppToastProvider", () => {
  it("gives every toast a translated close button that dismisses it", async () => {
    const user = userEvent.setup();
    renderToasts("zh");
    act(() => {
      toast.error("出错了");
    });
    expect((await screen.findAllByText("出错了")).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "通知" })).toBeInTheDocument();

    // Base UI keeps the toast aria-hidden and announces it through the live region instead.
    const close = document.querySelector<HTMLButtonElement>('[data-slot="toast-close"]');
    expect(close).toHaveAttribute("aria-label", "关闭通知");
    if (close) await user.click(close);
    await waitFor(() => expect(screen.queryAllByText("出错了")).toHaveLength(0));
  });

  it("dismisses open toasts when the language changes", async () => {
    const user = userEvent.setup();
    renderToasts("en");
    act(() => {
      toast.info("Change the generated password in Settings.");
    });
    expect(
      (await screen.findAllByText("Change the generated password in Settings.")).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "switch" }));
    await waitFor(() =>
      expect(screen.queryAllByText("Change the generated password in Settings.")).toHaveLength(0),
    );
  });
});
