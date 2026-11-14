import { useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api/errors";
import {
  completeSession,
  createSession,
  deleteSession,
  isChallenge,
  type SecondFactor,
} from "@/lib/api/session";
import type { SessionCreateResponse } from "@/lib/api/types";
import { readStorage, writeStorage } from "@/lib/storage";

export interface Session {
  token: string;
  /** ms epoch; 0 = no expiry recorded */
  expiresAt: number;
  remember: boolean;
}

export type SessionChangeReason =
  | "signin"
  | "signout"
  | "expired"
  | "restored"
  | "password-changed";

export const TOKEN_KEY = "kiro_admin_token";
export const TOKEN_EXP_KEY = "kiro_admin_token_exp";
export const REMEMBER_KEY = "kiro_remember";

type Listener = (session: Session | null, reason: SessionChangeReason) => void;

const listeners = new Set<Listener>();
// The last value handed out, so repeated reads of unchanged storage return the same object
// (useSyncExternalStore needs a stable snapshot).
let snapshot: Session | null = null;

function notify(session: Session | null, reason: SessionChangeReason): void {
  for (const listener of [...listeners]) listener(session, reason);
}

function removeToken(area: "local" | "session"): void {
  writeStorage(TOKEN_KEY, null, area);
  writeStorage(TOKEN_EXP_KEY, null, area);
}

/** Reads sessionStorage first, then localStorage, like the old UI. Expired tokens are dropped. */
function readStored(): Session | null {
  let dropped = false;
  let found: Session | null = null;
  for (const area of ["session", "local"] as const) {
    const token = readStorage(TOKEN_KEY, area);
    if (!token) continue;
    const expiresAt = Number.parseInt(readStorage(TOKEN_EXP_KEY, area) ?? "0", 10) || 0;
    if (expiresAt && Date.now() >= expiresAt) {
      removeToken(area);
      dropped = true;
      continue;
    }
    found = { token, expiresAt, remember: area === "local" };
    break;
  }
  if (dropped && !found) {
    // Reads can happen during render, so tell subscribers after the current task.
    queueMicrotask(() => notify(null, "expired"));
  }
  return found;
}

export function getSession(): Session | null {
  const next = readStored();
  if (
    next &&
    snapshot &&
    next.token === snapshot.token &&
    next.expiresAt === snapshot.expiresAt &&
    next.remember === snapshot.remember
  ) {
    return snapshot;
  }
  snapshot = next;
  return snapshot;
}

export function getToken(): string | null {
  return getSession()?.token ?? null;
}

export function isAuthenticated(): boolean {
  return getSession() !== null;
}

/** The "Stay signed in" choice from the last sign-in. */
export function getRememberPreference(): boolean {
  return readStorage(REMEMBER_KEY) === "1";
}

/** Stores the token in localStorage when `remember`, else sessionStorage, and clears the other. */
export function setSession(session: Session, reason: SessionChangeReason = "signin"): void {
  const area = session.remember ? "local" : "session";
  removeToken(session.remember ? "session" : "local");
  writeStorage(TOKEN_KEY, session.token, area);
  writeStorage(TOKEN_EXP_KEY, String(session.expiresAt || 0), area);
  writeStorage(REMEMBER_KEY, session.remember ? "1" : null);
  notify(getSession(), reason);
}

/** Drops the token from both storage areas. The remember preference stays. */
export function clearSession(reason: SessionChangeReason): void {
  removeToken("session");
  removeToken("local");
  snapshot = null;
  notify(null, reason);
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function subscribeStore(onChange: () => void): () => void {
  return subscribeSession(() => onChange());
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeStore, getSession, () => null);
}

/** A sign-in either got its token, or waits for a two-factor code against `challenge`. */
export type SignInResult =
  | { kind: "signed-in" }
  | { kind: "two-factor"; challenge: string; expiresAt: number };

function storeToken(
  res: SessionCreateResponse | undefined,
  remember: boolean,
  reason: SessionChangeReason,
): void {
  if (!res?.token) throw new ApiError({ status: 401, serverMessage: "Unauthorized", body: res });
  setSession({ token: res.token, expiresAt: Number(res.expiresAt) || 0, remember }, reason);
}

async function startSession(
  password: string,
  remember: boolean,
  reason: SessionChangeReason,
): Promise<SignInResult> {
  const res = await createSession(password);
  if (isChallenge(res)) {
    return { kind: "two-factor", challenge: res.challenge, expiresAt: Number(res.expiresAt) || 0 };
  }
  storeToken(res, remember, reason);
  return { kind: "signed-in" };
}

export function signIn(password: string, remember: boolean): Promise<SignInResult> {
  return startSession(password, remember, "signin");
}

/** The code step of a sign-in with two-factor on: stores the token like signIn. */
export async function completeSignIn(
  challenge: string,
  factor: SecondFactor,
  remember: boolean,
): Promise<void> {
  storeToken(await completeSession(challenge, factor), remember, "signin");
}

/** Revokes the token server-side when possible; the local session ends either way. */
export async function signOut(): Promise<void> {
  try {
    if (getToken()) await deleteSession();
  } catch {
    // Already expired or unreachable: nothing left to revoke.
  }
  clearSession("signout");
}

/**
 * Signs in again after a password change, which revokes every session server-side. Keeps the
 * remember preference. On failure the stale session is cleared and the error rethrown.
 */
export async function reauthenticate(password: string): Promise<void> {
  try {
    const result = await startSession(password, getRememberPreference(), "password-changed");
    // With two-factor sign-in on, the server kept this session through the change instead.
    if (result.kind === "two-factor") notify(getSession(), "password-changed");
  } catch (error) {
    clearSession("expired");
    throw error;
  }
}
