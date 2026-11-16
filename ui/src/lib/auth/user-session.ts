import { useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

// The API key holder's session for the user panel (/user), apart from the admin session in
// session.ts: its own storage keys, so signing in or out of one never touches the other.

export type UserSessionChangeReason = "signed-in" | "signed-out" | "expired";

export const USER_TOKEN_KEY = "kiro_user_token";
export const USER_TOKEN_EXP_KEY = "kiro_user_token_exp";
export const USER_REMEMBER_KEY = "kiro_user_remember";

type Listener = (token: string | null, reason: UserSessionChangeReason) => void;

const listeners = new Set<Listener>();

function notify(token: string | null, reason: UserSessionChangeReason): void {
  // A copy, so a listener that subscribes during the call is not called for this change.
  for (const listener of Array.from(listeners)) listener(token, reason);
}

function removeToken(area: "local" | "session"): void {
  writeStorage(USER_TOKEN_KEY, null, area);
  writeStorage(USER_TOKEN_EXP_KEY, null, area);
}

/** sessionStorage first, then localStorage, like the admin session. Expired tokens are dropped. */
function readStored(): string | null {
  let dropped = false;
  for (const area of ["session", "local"] as const) {
    const token = readStorage(USER_TOKEN_KEY, area);
    if (!token) continue;
    const expiresAt = Number.parseInt(readStorage(USER_TOKEN_EXP_KEY, area) ?? "0", 10) || 0;
    if (expiresAt && Date.now() >= expiresAt) {
      removeToken(area);
      dropped = true;
      continue;
    }
    return token;
  }
  // Reads can happen during render, so tell subscribers after the current task.
  if (dropped) queueMicrotask(() => notify(null, "expired"));
  return null;
}

export function getUserToken(): string | null {
  return readStored();
}

export function isUserSignedIn(): boolean {
  return getUserToken() !== null;
}

/** The "Stay signed in" choice from the last sign-in to the user panel. */
export function getUserStaySignedIn(): boolean {
  return readStorage(USER_REMEMBER_KEY) === "1";
}

/**
 * Stores the token in localStorage when `staySignedIn`, else sessionStorage, and clears the
 * other. `expiresAt` is a ms epoch (0 = none recorded); once past, the token reads as signed out.
 */
export function setUserToken(token: string, staySignedIn: boolean, expiresAt = 0): void {
  const area = staySignedIn ? "local" : "session";
  removeToken(staySignedIn ? "session" : "local");
  writeStorage(USER_TOKEN_KEY, token, area);
  writeStorage(USER_TOKEN_EXP_KEY, String(expiresAt > 0 ? Math.floor(expiresAt) : 0), area);
  writeStorage(USER_REMEMBER_KEY, staySignedIn ? "1" : null);
  notify(token, "signed-in");
}

/** Drops the token from both storage areas. The "Stay signed in" choice stays. */
export function clearUserToken(reason: UserSessionChangeReason = "signed-out"): void {
  removeToken("session");
  removeToken("local");
  notify(null, reason);
}

export function subscribeUserSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Another tab's sign-in or sign-out reaches this one only as a storage event, and only for the
 * shared "Stay signed in" token in localStorage. A tab with its own session-only token keeps it.
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== USER_TOKEN_KEY) return;
  if (readStorage(USER_TOKEN_KEY, "session")) return;
  const token = getUserToken();
  notify(token, token ? "signed-in" : "signed-out");
}

if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

function subscribeStore(onChange: () => void): () => void {
  return subscribeUserSession(() => onChange());
}

/** The current user-panel token, re-rendering on sign-in, sign-out and expiry. */
export function useUserToken(): string | null {
  return useSyncExternalStore(subscribeStore, getUserToken, () => null);
}
