import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_KEY } from "@/lib/auth/session";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";

const PASSWORD = "12345678";

function storedToken(): { local: string | null; session: string | null } {
  return { local: localStorage.getItem(TOKEN_KEY), session: sessionStorage.getItem(TOKEN_KEY) };
}

function passwordInput(): HTMLInputElement {
  return screen.getByLabelText("Password") as HTMLInputElement;
}

function submitButton(): HTMLElement {
  return screen.getByRole("button", { name: "Sign in" });
}

beforeEach(() => {
  // First-run done, so /login renders instead of redirecting to /setup.
  mockDb.firstRunPending = false;
});

describe("LoginPage", () => {
  it("renders the sign-in card with the first-run hint absent", async () => {
    await renderApp("/login", { authed: false });
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Enter the admin password to continue.")).toBeInTheDocument();
    expect(passwordInput()).toHaveAttribute("type", "password");
    expect(passwordInput()).toHaveAttribute("autocomplete", "current-password");
    expect(passwordInput()).toHaveAttribute("placeholder", "Password");
    expect(passwordInput()).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "Stay signed in" })).not.toBeChecked();
    const labels = screen.getByRole("list", { name: "Works with" });
    expect(
      within(labels)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Claude API/v1/messages", "OpenAI API/v1/chat/completions", "Codex/v1/responses"]);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      `© ${new Date().getFullYear()}·Kiro Proxy`,
    );
    expect(screen.queryByText("Self-hosted · No telemetry")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("contentinfo")).getByText(
        "Not affiliated with Amazon, AWS, or Kiro.",
      ),
    ).toBeInTheDocument();
    // Language and theme are separate controls at the top; the footer holds only text, and the
    // app icon sits over the heading.
    expect(screen.getByRole("combobox", { name: "Language: English" })).toHaveTextContent(
      "English",
    );
    const theme = screen.getByRole("group", { name: "Theme" });
    expect(
      within(theme)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["System", "Light", "Dark"]);
    expect(within(screen.getByRole("contentinfo")).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();
  });

  it("starts the remember checkbox from the last choice", async () => {
    localStorage.setItem("kiro_remember", "1");
    await renderApp("/login", { authed: false });
    expect(screen.getByRole("checkbox", { name: "Stay signed in" })).toBeChecked();
  });

  it("shows a field error for an empty submit and sends no request", async () => {
    let calls = 0;
    mockServer.use(
      http.post(apiUrl("/session"), () => {
        calls += 1;
        return jsonError(401, "Unauthorized");
      }),
    );
    const { user } = await renderApp("/login", { authed: false });
    await user.click(submitButton());
    expect(await screen.findByText("Enter the password.")).toBeInTheDocument();
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput()).toHaveAccessibleDescription("Enter the password.");
    expect(calls).toBe(0);
  });

  it("shows Incorrect password for a wrong password and stores no token", async () => {
    const { user, router } = await renderApp("/login", { authed: false });
    await user.type(passwordInput(), "wrong-password");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Incorrect password.")).toBeInTheDocument();
    expect(passwordInput()).toHaveAccessibleDescription("Incorrect password.");
    expect(storedToken()).toEqual({ local: null, session: null });
    expect(router.state.location.pathname).toBe("/login");
  });

  it("shows the connection error when the proxy cannot be reached", async () => {
    mockServer.use(http.post(apiUrl("/session"), () => HttpResponse.error()));
    const { user } = await renderApp("/login", { authed: false });
    await user.type(passwordInput(), PASSWORD);
    await user.click(submitButton());
    expect(await screen.findByText("Could not connect to the proxy.")).toBeInTheDocument();
  });

  it("shows the connection error, not the status text, for a gateway error", async () => {
    // A reverse proxy in front of Kiro Proxy answers 502 with only its status text.
    mockServer.use(
      http.post(apiUrl("/session"), () => new HttpResponse("Bad Gateway", { status: 502 })),
    );
    const { user } = await renderApp("/login", { authed: false });
    await user.type(passwordInput(), PASSWORD);
    await user.click(submitButton());
    expect(await screen.findByText("Could not connect to the proxy.")).toBeInTheDocument();
    expect(screen.queryByText("Bad Gateway")).not.toBeInTheDocument();
  });

  describe("rate limit", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("counts down Retry-After and keeps Sign in disabled until 0", async () => {
      mockServer.use(
        http.post(apiUrl("/session"), () =>
          jsonError(429, "Too many admin password attempts; try again later", undefined, {
            "Retry-After": "3",
          }),
        ),
      );
      const { user } = await renderApp("/login", { authed: false });
      await user.type(passwordInput(), "wrong-password");
      await user.click(submitButton());

      const notice = await screen.findByText("Too many attempts. Try again in 3 s.");
      expect(notice.closest("[aria-live='polite']")).not.toBeNull();
      expect(submitButton()).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByText("Too many attempts. Try again in 2 s.")).toBeInTheDocument();
      expect(submitButton()).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      await waitFor(() => expect(submitButton()).toBeEnabled());
      expect(screen.queryByText(/Too many attempts/)).not.toBeInTheDocument();
    });
  });

  it("stores the token in localStorage with Stay signed in and lands on Overview", async () => {
    const { user, router } = await renderApp("/login", { authed: false });
    await user.click(screen.getByRole("checkbox", { name: "Stay signed in" }));
    await user.type(passwordInput(), PASSWORD);
    await user.click(submitButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    const { local, session } = storedToken();
    expect(local).toMatch(/^mock-/);
    expect(session).toBeNull();
  });

  it("stores the token in sessionStorage without Stay signed in", async () => {
    const { user, router } = await renderApp("/login", { authed: false });
    await user.type(passwordInput(), PASSWORD);
    await user.click(submitButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    const { local, session } = storedToken();
    expect(session).toMatch(/^mock-/);
    expect(local).toBeNull();
  });

  it("follows ?redirect after sign-in", async () => {
    const { user, router } = await renderApp("/login?redirect=%2Fbackups", { authed: false });
    await user.type(passwordInput(), PASSWORD);
    await user.click(submitButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/backups"));
  });

  it("toggles password visibility with the eye button", async () => {
    const { user } = await renderApp("/login", { authed: false });
    expect(passwordInput()).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(passwordInput()).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput()).toHaveAttribute("type", "password");
  });
});
