import { queryOptions } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markSignInReason } from "@/features/auth/sign-in-reason";
import { getFirstRun } from "@/lib/api/session";
import { USER_API_BASE } from "@/lib/api/user-panel";
import { isAuthenticated, type Session, type SessionChangeReason } from "@/lib/auth/session";
import { USER_TOKEN_KEY } from "@/lib/auth/user-session";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";

type SessionListener = (session: Session | null, reason: SessionChangeReason) => void;
const sessionListeners = new Set<SessionListener>();

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    isAuthenticated: vi.fn(() => false),
    subscribeSession: vi.fn((listener: SessionListener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    }),
  };
});

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  const getFirstRunMock = vi.fn();
  return {
    ...actual,
    getFirstRun: getFirstRunMock,
    firstRunQuery: () =>
      queryOptions({
        queryKey: ["first-run"],
        queryFn: () => getFirstRunMock(),
        staleTime: 0,
        gcTime: 0,
        retry: false,
      }),
  };
});

// The shell's version check must not reach the network in these tests.
vi.mock("@/lib/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/system")>();
  return {
    ...actual,
    versionQuery: () =>
      queryOptions({
        queryKey: ["version"],
        queryFn: () => Promise.resolve({ version: "v2.1.0" }),
        staleTime: Number.POSITIVE_INFINITY,
      }),
    fetchRemoteVersion: () => new Promise(() => {}),
  };
});

const authed = vi.mocked(isAuthenticated);
const firstRun = vi.mocked(getFirstRun);

beforeEach(() => {
  authed.mockReset();
  authed.mockReturnValue(false);
  firstRun.mockReset();
  firstRun.mockResolvedValue({ password: "" });
});

describe("route guards", () => {
  it("sends an unauthenticated visit to sign-in with a redirect back", async () => {
    const { router } = await renderApp("/accounts", { authed: false });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/accounts" });
    expect(router.state.location.href).toBe("/login?redirect=%2Faccounts");
  });

  it("sends a key holder's visit to an admin page to their own page, not the admin sign-in", async () => {
    // Signed in with an API key only; the /user page's data is stubbed (any token reads as live).
    sessionStorage.setItem(USER_TOKEN_KEY, "c".repeat(64));
    mockServer.use(http.get(`${USER_API_BASE}/*`, () => HttpResponse.json({})));
    for (const path of ["/", "/accounts"]) {
      const { router } = await renderApp(path, { authed: false });
      await waitFor(() => expect(router.state.location.pathname).toBe("/user"));
    }
  });

  it("keeps the admin on admin pages when an API key is signed in too", async () => {
    authed.mockReturnValue(true);
    sessionStorage.setItem(USER_TOKEN_KEY, "c".repeat(64));
    const { router } = await renderApp("/accounts");
    expect(router.state.location.pathname).toBe("/accounts");
  });

  it("keeps the query string in the redirect", async () => {
    const { router } = await renderApp("/requests?page=2", { authed: false });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/requests?page=2" });
  });

  it("sends an authenticated /login visit to Overview", async () => {
    authed.mockReturnValue(true);
    const { router } = await renderApp("/login");
    expect(router.state.location.pathname).toBe("/");
  });

  it("follows a validated redirect after an authenticated /login visit", async () => {
    authed.mockReturnValue(true);
    const { router } = await renderApp("/login?redirect=%2Fbackups");
    expect(router.state.location.pathname).toBe("/backups");
  });

  it("sends /login to /setup while first-run is pending", async () => {
    firstRun.mockResolvedValue({ password: "12345678" });
    const { router } = await renderApp("/login", { authed: false });
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("keeps the requested page through first-run setup", async () => {
    firstRun.mockResolvedValue({ password: "12345678" });
    const { router } = await renderApp("/accounts?plan=pro", { authed: false });
    expect(router.state.location.pathname).toBe("/setup");
    expect(router.state.location.search).toEqual({ redirect: "/accounts?plan=pro" });
  });

  it("keeps the return path when a claimed setup sends the user to login", async () => {
    const { router } = await renderApp("/setup?redirect=%2Faccounts", { authed: false });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/accounts" });
  });

  it("still renders /login when first-run cannot be fetched", async () => {
    firstRun.mockRejectedValue(new Error("network"));
    const { router } = await renderApp("/login", { authed: false });
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends /setup to /login once first-run is done", async () => {
    firstRun.mockResolvedValue({ password: "" });
    const { router } = await renderApp("/setup", { authed: false });
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends an authenticated /setup visit to Overview", async () => {
    authed.mockReturnValue(true);
    firstRun.mockResolvedValue({ password: "12345678" });
    const { router } = await renderApp("/setup");
    expect(router.state.location.pathname).toBe("/");
  });

  it("goes to sign-in, which says the session expired, when it expires", async () => {
    authed.mockReturnValue(true);
    const { router } = await renderApp("/accounts");
    expect(router.state.location.pathname).toBe("/accounts");

    authed.mockReturnValue(false);
    act(() => {
      for (const listener of sessionListeners) listener(null, "expired");
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ redirect: "/accounts" });
    const notice = await screen.findByText("Your session expired. Sign in again.");
    expect(notice.closest("[role=alert]")).not.toBeNull();
  });

  it("goes to sign-in, which says the backup was restored, after a restore", async () => {
    authed.mockReturnValue(true);
    const { router, user } = await renderApp("/backups");
    authed.mockReturnValue(false);
    // The backups page marks the reason as its restore ends the session.
    markSignInReason("admin", "restored");
    act(() => {
      for (const listener of sessionListeners) listener(null, "restored");
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({});
    const notice = await screen.findByText(
      "Backup restored. Sign in with the password stored in the backup.",
    );
    expect(notice.closest("[role=alert]")).not.toBeNull();
    expect(screen.queryByText("Your session expired. Sign in again.")).toBeNull();
    // The next attempt takes its place.
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.queryByText(notice.textContent ?? "")).toBeNull();
  });

  it("says nothing about an expired session after a sign-out", async () => {
    authed.mockReturnValue(true);
    const { router } = await renderApp("/accounts");
    authed.mockReturnValue(false);
    act(() => {
      for (const listener of sessionListeners) listener(null, "signout");
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByText("Your session expired. Sign in again.")).toBeNull();
  });

  it("does not move on a password change", async () => {
    authed.mockReturnValue(true);
    const { router } = await renderApp("/settings");
    act(() => {
      for (const listener of sessionListeners) listener(null, "password-changed");
    });
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("renders the not-found page for an unknown path", async () => {
    authed.mockReturnValue(true);
    const { findByRole } = await renderApp("/nope");
    expect(await findByRole("link")).toHaveAttribute("href", "/");
  });
});
