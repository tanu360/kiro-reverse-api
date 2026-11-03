import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, useLanguage } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { AppToaster } from "./app-toasts";

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
      <LanguageButton />
      <AppToaster />
    </I18nProvider>,
  );
}

function island(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="notch-toast"]');
}

afterEach(() => {
  act(() => toast.dismiss());
});

describe("AppToaster", () => {
  it("gives error toasts a translated close button that dismisses them", async () => {
    const user = userEvent.setup();
    renderToasts("zh");
    act(() => {
      toast.error("出错了");
    });
    expect(await screen.findByText("出错了")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "通知" })).toBeInTheDocument();
    expect(island()).toHaveAttribute("data-type", "error");

    await user.click(screen.getByRole("button", { name: "关闭通知" }));
    await waitFor(() => expect(screen.queryByText("出错了")).not.toBeInTheDocument());
  });

  it("announces errors assertively and everything else politely", async () => {
    renderToasts("en");
    act(() => {
      toast.success("Saved");
    });
    const live = (await screen.findByText("Saved")).closest("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    act(() => {
      toast.error("Save failed");
    });
    await screen.findByText("Save failed");
    expect(live).toHaveAttribute("aria-live", "assertive");
  });

  it("dismisses open toasts when the language changes", async () => {
    const user = userEvent.setup();
    renderToasts("en");
    act(() => {
      toast.info("Change the generated password in Settings.");
    });
    expect(await screen.findByText("Change the generated password in Settings.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "switch" }));
    await waitFor(() =>
      expect(screen.queryByText("Change the generated password in Settings.")).toBeNull(),
    );
  });

  it("keeps an error under a newer timed toast and shows it again when that one goes", async () => {
    renderToasts("en");
    act(() => {
      toast.error("Refresh failed");
      toast.success("Copied", { duration: 50 });
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(screen.queryByText("Refresh failed")).toBeNull();
    expect(await screen.findByText("Refresh failed", {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("morphs a toast in place when it is shown again with the same id", async () => {
    renderToasts("en");
    act(() => {
      toast.warning("Session expired", { id: "session-expired" });
      toast.warning("Session expired", { id: "session-expired" });
    });
    await waitFor(() => expect(screen.getAllByText("Session expired")).toHaveLength(1));
  });

  it("settles a loading toast through update: a timed result goes, an error stays", async () => {
    renderToasts("en");
    let id = "";
    act(() => {
      id = toast.loading("Refreshing models…");
    });
    expect(await screen.findByText("Refreshing models…")).toBeInTheDocument();
    expect(island()).toHaveAttribute("data-type", "loading");

    act(() => toast.update(id, { type: "success", title: "Refreshed", duration: 50 }));
    expect(await screen.findByText("Refreshed")).toBeInTheDocument();
    await waitFor(() => expect(island()).toBeNull());

    act(() => {
      id = toast.loading("Refreshing models…");
    });
    act(() => toast.update(id, { type: "error", title: "Refresh failed" }));
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(island()).toHaveAttribute("data-type", "error");
  });

  it("closes the toast with Escape, but leaves Escape inside a dialog to the dialog", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initialLang="en">
        <div role="dialog">
          <button type="button">inside</button>
        </div>
        <AppToaster />
      </I18nProvider>,
    );
    act(() => {
      toast.error("Save failed");
    });
    await screen.findByText("Save failed");

    screen.getByRole("button", { name: "inside" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.getByText("Save failed")).toBeInTheDocument();

    (document.activeElement as HTMLElement).blur();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Save failed")).toBeNull());
  });
});
