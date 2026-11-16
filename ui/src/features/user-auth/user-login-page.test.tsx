import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_API_BASE } from "@/lib/api/user-panel";
import { clearSession, getToken } from "@/lib/auth/session";
import { getUserToken, setUserToken, USER_TOKEN_KEY } from "@/lib/auth/user-session";
import { mockDb } from "@/lib/mocks/db";
import { jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";
import { userRedirectTarget, validateUserLoginSearch } from "./redirect";

const KEY = "sk-test-key-0001";
const SESSION_URL = `${USER_API_BASE}/session`;

function storedToken(): { local: string | null; session: string | null } {
  return {
    local: localStorage.getItem(USER_TOKEN_KEY),
    session: sessionStorage.getItem(USER_TOKEN_KEY),
  };
}

function keyInput(): HTMLInputElement {
  return screen.getByLabelText("API key") as HTMLInputElement;
}

function submitButton(): HTMLElement {
  return screen.getByRole("button", { name: "Sign in" });
}

/** POST /user/api/session: a token for KEY, 401 user_key_invalid for any other key. */
function serveSession(onBody?: (body: unknown) => void): void {
  mockServer.use(
    http.post(SESSION_URL, async ({ request }) => {
      const body = (await request.json()) as { key?: string };
      onBody?.(body);
      if (!body.key) return jsonError(400, "key is required", { code: "user_key_required" });
      if (body.key !== KEY) return jsonError(401, "Invalid API key", { code: "user_key_invalid" });
      return HttpResponse.json({
        token: "a".repeat(64),
        expiresAt: Math.floor(Date.now() / 1000) + 12 * 3600,
      });
    }),
  );
}

beforeEach(() => {
  // The admin /login renders instead of redirecting to /setup.
  mockDb.firstRunPending = false;
  serveSession();
  // The dashboard /user loads after sign-in; the user panel mock knows only the tokens it
  // issued, and its 401 would send the page back here. Any token reads as signed in.
  mockServer.use(http.get(`${USER_API_BASE}/*`, () => HttpResponse.json({})));
});

describe("UserLoginPage", () => {
  it("renders the sign-in frame with an API key field", async () => {
    await renderApp("/user/login", { authed: false });
    expect(
      screen.getByRole("heading", { level: 1, name: "Check your API key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sign in with your API key to see its usage, limits and requests."),
    ).toBeInTheDocument();
    expect(keyInput()).toHaveAttribute("type", "password");
    expect(keyInput()).toHaveAttribute("placeholder", "sk-…");
    expect(keyInput()).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "Stay signed in" })).not.toBeChecked();
    // The same showcase and footer as the admin sign-in.
    expect(screen.getByRole("list", { name: "Works with" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("contentinfo")).getByText("Not affiliated with Amazon, AWS or Kiro."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with the password" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(document.title).toBe("Check your API key · Kiro Proxy");
  });

  it("shows and hides the key with the eye button", async () => {
    const { user } = await renderApp("/user/login", { authed: false });
    await user.click(screen.getByRole("button", { name: "Show API key" }));
    expect(keyInput()).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide API key" }));
    expect(keyInput()).toHaveAttribute("type", "password");
  });

  it("asks for a key on an empty submit and sends no request", async () => {
    let calls = 0;
    serveSession(() => {
      calls += 1;
    });
    const { user } = await renderApp("/user/login", { authed: false });
    await user.click(submitButton());
    expect(await screen.findByText("Enter an API key.")).toBeInTheDocument();
    expect(keyInput()).toHaveAttribute("aria-invalid", "true");
    expect(keyInput()).toHaveAccessibleDescription("Enter an API key.");
    expect(calls).toBe(0);
  });

  it("sends the trimmed key and lands on /user with a session-only token", async () => {
    const bodies: unknown[] = [];
    serveSession((body) => bodies.push(body));
    const { user, router } = await renderApp("/user/login", { authed: false });
    await user.type(keyInput(), ` ${KEY} `);
    await user.click(submitButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/user"));
    expect(bodies).toEqual([{ key: KEY }]);
    expect(storedToken()).toEqual({ local: null, session: "a".repeat(64) });
  });

  it("keeps the token in localStorage with Stay signed in", async () => {
    const { user, router } = await renderApp("/user/login", { authed: false });
    await user.click(screen.getByRole("checkbox", { name: "Stay signed in" }));
    await user.type(keyInput(), KEY);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/user"));
    expect(storedToken()).toEqual({ local: "a".repeat(64), session: null });
  });

  it("shows the translated error for a wrong key and selects it for retyping", async () => {
    const { user, router } = await renderApp("/user/login", { authed: false, lang: "ja" });
    const input = screen.getByLabelText("API キー") as HTMLInputElement;
    await user.type(input, "sk-wrong");
    await user.click(screen.getByRole("button", { name: "サインイン" }));
    expect(await screen.findByText("API キーが正しくありません。")).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription("API キーが正しくありません。");
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "sk-wrong".length]);
    expect(storedToken()).toEqual({ local: null, session: null });
    expect(router.state.location.pathname).toBe("/user/login");
  });

  it("shows the connection error when the proxy cannot be reached", async () => {
    mockServer.use(http.post(SESSION_URL, () => HttpResponse.error()));
    const { user } = await renderApp("/user/login", { authed: false });
    await user.type(keyInput(), KEY);
    await user.click(submitButton());
    expect(await screen.findByText("Could not connect to the proxy.")).toBeInTheDocument();
  });

  describe("rate limit", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the wait and keeps Sign in aria-disabled until it ends", async () => {
      mockServer.use(
        http.post(SESSION_URL, () =>
          jsonError(429, "Too many API key attempts; try again later", undefined, {
            "Retry-After": "90",
          }),
        ),
      );
      const { user } = await renderApp("/user/login", { authed: false });
      await user.type(keyInput(), "sk-wrong");
      await user.click(submitButton());

      const notice = await screen.findByText("Too many attempts. Try again in 1m 30s.");
      expect(notice.closest("[aria-live='polite']")).not.toBeNull();
      expect(notice).toHaveClass("tabular-nums");
      expect(submitButton()).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        vi.advanceTimersByTime(90_000);
      });
      await waitFor(() => expect(submitButton()).not.toHaveAttribute("aria-disabled"));
      expect(screen.queryByText(/Too many attempts/)).not.toBeInTheDocument();
    });
  });

  it("sends a signed-in key holder straight to /user", async () => {
    sessionStorage.setItem(USER_TOKEN_KEY, "b".repeat(64));
    const { router } = await renderApp("/user/login", { authed: false });
    await waitFor(() => expect(router.state.location.pathname).toBe("/user"));
  });

  it("follows a user panel redirect with its query after signing in", async () => {
    const { user, router } = await renderApp(
      `/user/login?redirect=${encodeURIComponent("/user?range=7d")}`,
      { authed: false },
    );
    await user.type(keyInput(), KEY);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/user"));
    expect(router.state.location.search).toEqual({ range: "7d" });
  });

  it.each(["//evil.example", "/accounts", "javascript:alert(1)"])(
    "drops the redirect %s and lands on /user",
    async (redirect) => {
      const { user, router } = await renderApp(
        `/user/login?redirect=${encodeURIComponent(redirect)}`,
        { authed: false },
      );
      await user.type(keyInput(), KEY);
      await user.keyboard("{Enter}");
      await waitFor(() => expect(router.state.location.pathname).toBe("/user"));
      expect(router.state.location.search).toEqual({});
    },
  );

  it("stays on the sign-in page on Back after signing out", async () => {
    mockServer.use(http.delete(SESSION_URL, () => new HttpResponse(null, { status: 204 })));
    const { user, router } = await renderApp("/user/login", { authed: false });
    await user.type(keyInput(), KEY);
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { level: 1, name: "API key" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
    await act(async () => {
      router.history.back();
    });
    await waitFor(() => expect(router.state.status).toBe("idle"));
    expect(router.state.location.pathname).toBe("/user/login");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("keeps the admin session when the key holder signs out, and the other way round", async () => {
    mockServer.use(http.delete(SESSION_URL, () => new HttpResponse(null, { status: 204 })));
    // An admin signed in in this browser too (renderApp's default session).
    const { user, router } = await renderApp("/user/login", { authed: true });
    await user.type(keyInput(), KEY);
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { level: 1, name: "API key" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
    expect(getToken()).toBe("mock-test");

    setUserToken("c".repeat(64), true);
    clearSession("signout");
    expect(getUserToken()).toBe("c".repeat(64));
  });

  it("links from the admin sign-in to the key sign-in", async () => {
    const { user, router } = await renderApp("/login", { authed: false });
    await user.click(screen.getByRole("link", { name: "Check its usage" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/user/login"));
    expect(screen.getByRole("heading", { level: 1, name: "Check your API key" })).toBeVisible();
  });
});

describe("user sign-in redirect", () => {
  it("keeps only user panel pages", () => {
    expect(validateUserLoginSearch({ redirect: "/user?range=7d" })).toEqual({
      redirect: "/user?range=7d",
    });
    for (const redirect of [
      "/accounts",
      "//evil.example",
      "/user/login",
      "/user/../api",
      "/users",
      "javascript:alert(1)",
      "https://evil.example/user",
      "/user\\@evil.example",
    ])
      expect(validateUserLoginSearch({ redirect }), redirect).toEqual({ redirect: undefined });
  });

  it("goes to /user by default and splits a query off", () => {
    expect(userRedirectTarget(undefined)).toEqual({ to: "/user", search: {} });
    expect(userRedirectTarget("/settings")).toEqual({ to: "/user", search: {} });
    expect(userRedirectTarget("/user?range=7d")).toEqual({ to: "/user", search: { range: "7d" } });
  });
});
