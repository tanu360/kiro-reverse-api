export interface Session {
  token: string;
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

// Skeleton: Task 3 implements the session store. Until then nobody is signed in.

export function getSession(): Session | null {
  return null;
}

export function getToken(): string | null {
  return null;
}

export function isAuthenticated(): boolean {
  return false;
}

export function getRememberPreference(): boolean {
  return false;
}

export function setSession(_session: Session, _reason?: SessionChangeReason): void {}

export function clearSession(_reason: SessionChangeReason): void {}

export function subscribeSession(
  _listener: (session: Session | null, reason: SessionChangeReason) => void,
): () => void {
  return () => {};
}

export function useSession(): Session | null {
  return null;
}

export function signIn(_password: string, _remember: boolean): Promise<void> {
  return Promise.reject(new Error("not implemented"));
}

export function signOut(): Promise<void> {
  return Promise.reject(new Error("not implemented"));
}

export function reauthenticate(_password: string): Promise<void> {
  return Promise.reject(new Error("not implemented"));
}
