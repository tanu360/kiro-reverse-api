import { queryOptions } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFirstRun } from "@/lib/api/session";
import { isAuthenticated, type Session, type SessionChangeReason } from "@/lib/auth/session";
import { toast } from "@/lib/toast";
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

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

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

  it("goes to sign-in with one toast when the session expires", async () => {
    authed.mockReturnValue(true);
    const { router } = await renderApp("/accounts");
    expect(router.state.location.pathname).toBe("/accounts");

    authed.mockReturnValue(false);
    act(() => {
      for (const listener of sessionListeners) listener(null, "expired");
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0]?.[1]).toEqual({ id: "session-expired" });
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
    expect(await findByRole("link")).toHaveAttribute("href", "/admin/");
  });
});
