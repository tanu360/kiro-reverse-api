import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogPopup, DialogTitle } from "@/components/ui/dialog";
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

/** The visible title; Base UI also renders a hidden announcer copy of urgent toasts. */
async function findTitle(text: string): Promise<HTMLElement> {
  const matches = await screen.findAllByText(text);
  const title = matches.find((node) => node.getAttribute("data-slot") === "toast-title");
  if (!title) throw new Error(`no toast titled "${text}"`);
  return title;
}

afterEach(() => {
  act(() => toast.dismiss());
});

describe("AppToaster", () => {
  it("puts the toasts in a translated region", async () => {
    renderToasts("zh");
    act(() => {
      toast.warning("出错了");
    });
    expect(await findTitle("出错了")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "通知" })).toBeInTheDocument();
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

  it("replaces a toast in place when it is shown again with the same id", async () => {
    renderToasts("en");
    act(() => {
      toast.warning("Session expired", { id: "session-expired" });
      toast.warning("Session expired", { id: "session-expired" });
    });
    await waitFor(() => expect(screen.getAllByText("Session expired")).toHaveLength(1));
  });

  it("settles a loading toast through update: a short result goes, an error stays longer", async () => {
    renderToasts("en");
    let id = "";
    act(() => {
      id = toast.loading("Refreshing models…");
    });
    expect(await screen.findByText("Refreshing models…")).toBeInTheDocument();

    act(() => toast.update(id, { type: "success", title: "Refreshed", duration: 50 }));
    expect(await screen.findByText("Refreshed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Refreshed")).toBeNull());

    act(() => {
      id = toast.loading("Refreshing models…");
    });
    act(() => toast.update(id, { type: "error", title: "Refresh failed" }));
    expect(await findTitle("Refresh failed")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await findTitle("Refresh failed")).toBeInTheDocument();
  });

  it("runs the action and closes the toast", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderToasts("en");
    act(() => {
      toast.warning("Update available: 2.2.0", { action: { label: "View", onClick } });
    });
    await user.click(await screen.findByRole("button", { name: "View" }));
    expect(onClick).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText("Update available: 2.2.0")).toBeNull());
  });

  it("stays exposed to assistive tech while a modal dialog hides the page", async () => {
    render(
      <I18nProvider initialLang="en">
        <main>
          <button type="button">behind</button>
        </main>
        <Dialog defaultOpen>
          <DialogPopup>
            <DialogTitle>Add account</DialogTitle>
            <button type="button">inside</button>
          </DialogPopup>
        </Dialog>
        <AppToaster />
      </I18nProvider>,
    );
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.queryByRole("button", { name: "behind" })).toBeNull());
    act(() => {
      toast.warning("Sign-in failed");
    });
    const title = await findTitle("Sign-in failed");
    expect(title.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("marks errors and warnings with an icon and keeps success and info plain", async () => {
    renderToasts("en");
    act(() => {
      toast.success("Saved");
      toast.info("Heads up");
    });
    await findTitle("Heads up");
    expect(document.querySelector('[data-slot="toast-icon"]')).toBeNull();

    act(() => {
      toast.error("Save failed");
    });
    const title = await findTitle("Save failed");
    const root = title.closest('[data-slot="toast"]');
    expect(root).toHaveAttribute("data-type", "error");
    expect(root?.querySelector('[data-slot="toast-icon"]')).not.toBeNull();
  });

  it("drops the loading spinner when the toast settles as a success", async () => {
    renderToasts("en");
    let id = "";
    act(() => {
      id = toast.loading("Refreshing models…");
    });
    const loading = await findTitle("Refreshing models…");
    expect(loading.closest('[data-slot="toast"]')).toHaveAttribute("data-type", "loading");

    act(() => toast.update(id, { type: "success", title: "Refreshed" }));
    const settled = await findTitle("Refreshed");
    expect(settled.closest('[data-slot="toast"]')).not.toHaveAttribute("data-type");
  });

  it("closes a toast from its close button", async () => {
    const user = userEvent.setup();
    renderToasts("en");
    act(() => {
      toast.error("Save failed");
    });
    const title = await findTitle("Save failed");
    const close = title
      .closest('[data-slot="toast"]')
      ?.querySelector<HTMLElement>('[data-slot="toast-close"]');
    if (!close) throw new Error("no close button");
    // Base UI hides it from assistive tech until the stack is expanded or it takes focus.
    expect(close).toHaveAttribute("aria-label", "Close");
    await user.click(close);
    await waitFor(() => expect(screen.queryByText("Save failed")).toBeNull());
  });

  it("puts toasts at the top centre on phones and the bottom right from sm up", async () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(max-width: 639px)",
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    const phone = renderToasts("en");
    expect(document.querySelector('[data-slot="toast-viewport"]')).toHaveAttribute(
      "data-position",
      "top-center",
    );
    phone.unmount();
    matchMedia.mockRestore();

    renderToasts("en");
    expect(document.querySelector('[data-slot="toast-viewport"]')).toHaveAttribute(
      "data-position",
      "bottom-right",
    );
  });
});
