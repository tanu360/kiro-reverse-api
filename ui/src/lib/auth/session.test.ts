import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { mockDb } from "@/lib/mocks/db";
import {
  clearSession,
  getRememberPreference,
  getSession,
  REMEMBER_KEY,
  reauthenticate,
  type Session,
  type SessionChangeReason,
  setSession,
  signIn,
  signOut,
  subscribeSession,
  TOKEN_EXP_KEY,
  TOKEN_KEY,
} from "./session";

const HOUR_MS = 3_600_000;
const unsubscribers: Array<() => void> = [];

function record(): Array<[Session | null, SessionChangeReason]> {
  const calls: Array<[Session | null, SessionChangeReason]> = [];
  unsubscribers.push(subscribeSession((session, reason) => calls.push([session, reason])));
  return calls;
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

describe("session storage", () => {
  it("stores a remembered session in localStorage and clears sessionStorage", () => {
    sessionStorage.setItem(TOKEN_KEY, "stale");
    setSession({ token: "t1", expiresAt: Date.now() + HOUR_MS, remember: true });
    expect(localStorage.getItem(TOKEN_KEY)).toBe("t1");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REMEMBER_KEY)).toBe("1");
    expect(getSession()).toMatchObject({ token: "t1", remember: true });
  });

  it("stores a session-only token in sessionStorage and clears localStorage", () => {
    localStorage.setItem(TOKEN_KEY, "stale");
    localStorage.setItem(REMEMBER_KEY, "1");
    setSession({ token: "t2", expiresAt: Date.now() + HOUR_MS, remember: false });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("t2");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull();
    expect(getSession()).toMatchObject({ token: "t2", remember: false });
  });

  it("drops an expired stored token on read", () => {
    localStorage.setItem(TOKEN_KEY, "old");
    localStorage.setItem(TOKEN_EXP_KEY, String(Date.now() - 1000));
    expect(getSession()).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(TOKEN_EXP_KEY)).toBeNull();
  });

  it("returns the same object while storage is unchanged", () => {
    setSession({ token: "t3", expiresAt: Date.now() + HOUR_MS, remember: false });
    expect(getSession()).toBe(getSession());
  });

  it("tells subscribers why the session changed", () => {
    const calls = record();
    setSession({ token: "t4", expiresAt: Date.now() + HOUR_MS, remember: false }, "signin");
    clearSession("signout");
    expect(calls.map(([, reason]) => reason)).toEqual(["signin", "signout"]);
    expect(calls[0][0]?.token).toBe("t4");
    expect(calls[1][0]).toBeNull();
  });
});

describe("the session in another tab", () => {
  function storageEvent(newValue: string | null): void {
    window.dispatchEvent(
      new StorageEvent("storage", { key: TOKEN_KEY, newValue, storageArea: localStorage }),
    );
  }

  it("ends this tab's session when another tab signs out", () => {
    setSession({ token: "shared", expiresAt: Date.now() + HOUR_MS, remember: true });
    const calls = record();
    // The other tab removes the shared token; this tab only hears the storage event.
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    storageEvent(null);
    expect(calls).toEqual([[null, "signout"]]);
  });

  it("takes up the token another tab signed in with", () => {
    const calls = record();
    localStorage.setItem(TOKEN_KEY, "other");
    localStorage.setItem(TOKEN_EXP_KEY, String(Date.now() + HOUR_MS));
    storageEvent("other");
    expect(calls.map(([session, reason]) => [session?.token, reason])).toEqual([
      ["other", "signin"],
    ]);
  });

  it("ignores another tab's change while this tab keeps its own session-only token", () => {
    setSession({ token: "mine", expiresAt: Date.now() + HOUR_MS, remember: false });
    const calls = record();
    localStorage.setItem(TOKEN_KEY, "other");
    storageEvent("other");
    expect(calls).toEqual([]);
    expect(getSession()?.token).toBe("mine");
  });

  it("says nothing when the stored session did not change", () => {
    clearSession("signout");
    const calls = record();
    storageEvent(null);
    expect(calls).toEqual([]);
  });
});

describe("signIn", () => {
  it("throws ApiError 401 for a wrong password and stores nothing", async () => {
    const error = await signIn("wrong-password", true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(getSession()).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("stores the token and announces 'signin'", async () => {
    const calls = record();
    await signIn(mockDb.adminPassword, false);
    expect(getSession()?.token).toMatch(/^mock-/);
    expect(calls.map(([, reason]) => reason)).toEqual(["signin"]);
  });
});

describe("signOut", () => {
  it("clears the session even when the server call fails", async () => {
    setSession({ token: "not-a-mock-token", expiresAt: Date.now() + HOUR_MS, remember: true });
    const calls = record();
    await signOut();
    expect(getSession()).toBeNull();
    expect(calls.at(-1)?.[1]).toBe("signout");
  });
});

describe("reauthenticate", () => {
  it("keeps the remember preference and announces 'password-changed'", async () => {
    await signIn(mockDb.adminPassword, true);
    const first = getSession()?.token;
    const calls = record();
    await reauthenticate(mockDb.adminPassword);
    expect(getRememberPreference()).toBe(true);
    expect(getSession()).toMatchObject({ remember: true });
    expect(getSession()?.token).not.toBe(first);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(getSession()?.token);
    expect(calls.map(([, reason]) => reason)).toEqual(["password-changed"]);
  });

  it("keeps a session-only choice", async () => {
    await signIn(mockDb.adminPassword, false);
    await reauthenticate(mockDb.adminPassword);
    expect(getSession()).toMatchObject({ remember: false });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(getSession()?.token);
  });

  it("clears the session and rethrows when the new password is rejected", async () => {
    await signIn(mockDb.adminPassword, true);
    const calls = record();
    await expect(reauthenticate("not-the-password")).rejects.toBeInstanceOf(ApiError);
    expect(getSession()).toBeNull();
    expect(calls.map(([, reason]) => reason)).toEqual(["expired"]);
  });
});
