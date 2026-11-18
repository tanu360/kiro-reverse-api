import { act, screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { clearSession } from "@/lib/auth/session";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";
import { showChangePasswordNotice } from "./change-password-notice";

// Mock first-run is pending on a fresh mock database (password 12345678).
const PASSWORD = "12345678";

describe("SetupPage", () => {
  it("is where /login goes while first-run is pending, and shows the password", async () => {
    const { router } = await renderApp("/login", { authed: false });
    expect(router.state.location.pathname).toBe("/setup");
    expect(
      screen.getByRole("heading", { level: 1, name: "Welcome to Kiro Proxy" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(PASSWORD)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${PASSWORD} Copy password` })).toBeInTheDocument();
  });

  it("returns to the requested Accounts page after first-run sign-in", async () => {
    const { user, router } = await renderApp("/accounts?plan=pro", { authed: false });
    expect(router.state.location.pathname).toBe("/setup");
    await screen.findByText(PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/accounts"));
    expect(router.state.location.search).toMatchObject({ plan: "pro" });
    // The change-password line is module state: end the session so it does not reach the next test.
    act(() => clearSession("signout"));
  });

  it("copies the password when it is clicked, with no separate copy icon", async () => {
    const { user } = await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    await user.click(screen.getByRole("button", { name: `${PASSWORD} Copy password` }));
    expect(await navigator.clipboard.readText()).toBe(PASSWORD);
    // Confirmed in place (the label and a status for screen readers), not with a toast.
    expect(await screen.findByRole("status")).toHaveTextContent("Password copied to clipboard");
    expect(
      screen.queryByText("Password copied to clipboard", { selector: "[data-slot*=toast] *" }),
    ).toBeNull();
  });

  it("says a failed copy on the label above the password", async () => {
    const { user } = await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    const button = screen.getByRole("button", { name: `${PASSWORD} Copy password` });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copy-failed"));
    expect(button).not.toHaveAttribute("data-copied");
    // The label's red line (hidden from screen readers), and the line read out at once.
    await waitFor(() =>
      expect(
        screen
          .getAllByText("Could not copy to the clipboard.")
          .some((line) => line.closest('[data-slot="live-announcer"]')),
      ).toBe(true),
    );
  });

  it("shows the generated password as a line of text, not a second input box", async () => {
    await renderApp("/setup", { authed: false });
    const section = await screen.findByRole("region", { name: "First-run admin password" });
    expect(within(section).getByText("Generated password")).toBeInTheDocument();
    expect(within(section).getByText(PASSWORD)).toBeInTheDocument();
    // The password itself is the only control: no copy icon, no info button.
    const buttons = within(section).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(`${PASSWORD} Copy password`);
    expect(section.querySelector("input")).toBeNull();
    // The sign-in password field is the page's only input box.
    expect(document.querySelectorAll('[data-slot="input-group"]')).toHaveLength(1);
  });

  it("fills the generated password into the field", async () => {
    await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    expect(screen.getByLabelText("Password")).toHaveValue(PASSWORD);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("offers a retry when the generated password cannot load", async () => {
    mockServer.use(http.get(apiUrl("/first-run"), () => jsonError(500, "boom")));
    await renderApp("/setup", { authed: false });
    expect(await screen.findByText("Could not load the first-run password.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("signs in with the generated password, lands on Overview and points to Settings", async () => {
    const { user, router } = await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    // Prefilled: one click signs in.
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    // A line at the top of the page Overview, which can take over a second under a busy run.
    const open = await screen.findByRole("button", { name: "Open settings" }, { timeout: 4000 });
    expect(open.closest('[data-slot="change-password-notice"]')).toHaveTextContent(
      "Change the generated password in Settings.",
    );

    await user.click(open);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/security"));
    expect(router.state.location.hash).toBe("settings-admin-password");
    // Settings has it covered: the line does not come back on the next page.
    await act(async () => {
      await router.navigate({ to: "/" });
    });
    expect(document.querySelector('[data-slot="change-password-notice"]')).toBeNull();

    // First-run is claimed now: a later visit to /setup goes to sign-in.
    act(() => clearSession("signout"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    await act(async () => {
      await router.navigate({ to: "/setup" });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("closes the change-password line, with focus on the page", async () => {
    const { user, router } = await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    const open = await screen.findByRole("button", { name: "Open settings" }, { timeout: 4000 });
    const notice = open.closest('[data-slot="change-password-notice"]') as HTMLElement;
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
    expect(document.getElementById("main")).toHaveFocus();
    act(() => clearSession("signout"));
  });

  it("keeps the change-password line away when the sign-in led to Settings", async () => {
    const { router } = await renderApp("/settings/server");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    // Asked for after Settings mounted, as when the first-run sign-in returns to Settings.
    act(() => showChangePasswordNotice());
    expect(document.querySelector('[data-slot="change-password-notice"]')).toBeNull();
    await act(async () => {
      await router.navigate({ to: "/" });
    });
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(document.querySelector('[data-slot="change-password-notice"]')).toBeNull();
    act(() => clearSession("signout"));
  });

  it("drops the change-password line when the session ends", async () => {
    const { user, router } = await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(
      await screen.findByRole("button", { name: "Open settings" }, { timeout: 4000 }),
    ).toBeInTheDocument();

    act(() => clearSession("signout"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open settings" })).not.toBeInTheDocument(),
    );
  });
});
