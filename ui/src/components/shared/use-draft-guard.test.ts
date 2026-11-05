import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, createElement, type JSX } from "react";
import { describe, expect, it } from "vitest";
import { ConfirmProvider } from "@/components/shared/confirm-dialog";
import { clearSession, setSession } from "@/lib/auth/session";
import { I18nProvider } from "@/lib/i18n";
import { useDraftGuard } from "./use-draft-guard";

const MESSAGE = {
  title: "Discard changes?",
  description: "Your edits are not saved.",
  confirmLabel: "Discard",
  cancelLabel: "Keep editing",
};

function DraftPage(): JSX.Element {
  useDraftGuard(true, { message: MESSAGE });
  return createElement("p", null, "draft page");
}

function Shell(): JSX.Element {
  // The provider's children come as createElement's third argument, not in its props.
  const i18n = { initialLang: "en" } as ComponentProps<typeof I18nProvider>;
  return createElement(
    I18nProvider,
    i18n,
    createElement(ConfirmProvider, null, createElement(Outlet)),
  );
}

async function renderDraft(): Promise<AnyRouter> {
  setSession({ token: "mock-test", expiresAt: Date.now() + 3_600_000, remember: false });
  const rootRoute = createRootRoute({ component: Shell });
  const page = (path: string, text: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => createElement("p", null, text),
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/backups", component: DraftPage }),
      page("/accounts", "accounts page"),
      page("/login", "login page"),
      page("/setup", "setup page"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/backups"] }),
  });
  render(createElement(RouterProvider, { router }));
  await act(async () => {
    await router.load();
  });
  expect(await screen.findByText("draft page")).toBeInTheDocument();
  return router;
}

describe("useDraftGuard", () => {
  it("asks before another page drops the draft, and stays on Keep editing", async () => {
    const router = await renderDraft();
    act(() => {
      void router.navigate({ to: "/accounts" });
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Discard changes?" });
    expect(dialog).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(router.state.location.pathname).toBe("/backups");
    expect(screen.getByText("draft page")).toBeInTheDocument();
  });

  it.each(["/login", "/setup"] as const)("lets a move to %s through without asking", async (to) => {
    const router = await renderDraft();
    await act(async () => {
      await router.navigate({ to });
    });
    expect(router.state.location.pathname).toBe(to);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("lets every move through once the session has ended", async () => {
    const router = await renderDraft();
    clearSession("restored");
    await act(async () => {
      await router.navigate({ to: "/accounts" });
    });
    expect(router.state.location.pathname).toBe("/accounts");
    expect(screen.getByText("accounts page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
