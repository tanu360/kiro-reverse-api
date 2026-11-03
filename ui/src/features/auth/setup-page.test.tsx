import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { clearSession } from "@/lib/auth/session";
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
    expect(screen.getByRole("button", { name: "Copy password" })).toBeInTheDocument();
    expect(screen.getByText("It is shown until the first successful sign-in.")).toBeInTheDocument();
  });

  it("does not fill the password into the field", async () => {
    await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("signs in with the generated password, lands on Overview and points to Settings", async () => {
    const { user, router } = await renderApp("/setup", { authed: false });
    await screen.findByText(PASSWORD);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(
      await screen.findByText("Change the generated password in Settings."),
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
});
