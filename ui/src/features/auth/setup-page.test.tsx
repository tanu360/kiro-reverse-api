import { act, screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { clearSession } from "@/lib/auth/session";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";

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

  it("copies the password when it is clicked, with no separate copy icon", async () => {
    const { user } = await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    await user.click(screen.getByRole("button", { name: `${PASSWORD} Copy password` }));
    expect(await navigator.clipboard.readText()).toBe(PASSWORD);
    expect(await screen.findByText("Password copied to clipboard")).toBeInTheDocument();
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
    // The toast follows the Overview navigation, which can take over a second under a busy run.
    expect(
      await screen.findByText("Change the generated password in Settings.", {}, { timeout: 4000 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));

    // First-run is claimed now: a later visit to /setup goes to sign-in.
    act(() => clearSession("signout"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    await act(async () => {
      await router.navigate({ to: "/setup" });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("drops the change-password toast when the session ends", async () => {
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
