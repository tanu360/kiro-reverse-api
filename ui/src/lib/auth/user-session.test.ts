import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_KEY } from "./session";
import {
  clearUserToken,
  getUserStaySignedIn,
  getUserToken,
  isUserSignedIn,
  setUserToken,
  subscribeUserSession,
  USER_TOKEN_EXP_KEY,
  USER_TOKEN_KEY,
  type UserSessionChangeReason,
} from "./user-session";

const unsubscribers: Array<() => void> = [];

function recordReasons(): UserSessionChangeReason[] {
  const reasons: UserSessionChangeReason[] = [];
  unsubscribers.push(subscribeUserSession((_token, reason) => reasons.push(reason)));
  return reasons;
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  vi.restoreAllMocks();
});

describe("user session", () => {
  it("keeps the token in localStorage when staying signed in, else sessionStorage", () => {
    const reasons = recordReasons();
    setUserToken("tok-local", true);
    expect(localStorage.getItem(USER_TOKEN_KEY)).toBe("tok-local");
    expect(sessionStorage.getItem(USER_TOKEN_KEY)).toBeNull();
    expect(getUserStaySignedIn()).toBe(true);

    setUserToken("tok-session", false);
    expect(sessionStorage.getItem(USER_TOKEN_KEY)).toBe("tok-session");
    expect(localStorage.getItem(USER_TOKEN_KEY)).toBeNull();
    expect(getUserStaySignedIn()).toBe(false);
    expect(getUserToken()).toBe("tok-session");
    expect(isUserSignedIn()).toBe(true);
    expect(reasons).toEqual(["signed-in", "signed-in"]);
  });

  it("never touches the admin session", () => {
    localStorage.setItem(TOKEN_KEY, "admin-token");
    setUserToken("tok", true);
    clearUserToken();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("admin-token");
  });

  it("clears both areas and tells subscribers why", () => {
    const reasons = recordReasons();
    setUserToken("tok", true);
    sessionStorage.setItem(USER_TOKEN_KEY, "stale");
    clearUserToken();
    clearUserToken("expired");
    expect(getUserToken()).toBeNull();
    expect(isUserSignedIn()).toBe(false);
    expect(sessionStorage.getItem(USER_TOKEN_KEY)).toBeNull();
    expect(reasons).toEqual(["signed-in", "signed-out", "expired"]);
  });

  it("drops an expired token on read and reports it as expired", async () => {
    const reasons = recordReasons();
    setUserToken("tok", true, Date.now() - 1000);
    expect(getUserToken()).toBeNull();
    expect(localStorage.getItem(USER_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_TOKEN_EXP_KEY)).toBeNull();
    await Promise.resolve();
    expect(reasons).toEqual(["signed-in", "expired"]);
  });

  it("keeps a token whose expiry is ahead", () => {
    setUserToken("tok", false, Date.now() + 60_000);
    expect(getUserToken()).toBe("tok");
  });

  it("reads as signed out when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setUserToken("tok", true)).not.toThrow();
    expect(getUserToken()).toBeNull();
    expect(isUserSignedIn()).toBe(false);
  });
});
