import { useEffect, useState } from "react";
import { limitReachedReason } from "@/features/api/api-key-form";
import type { UserKey } from "@/lib/api/user-panel";

/**
 * Every state but `active` gets the key's requests refused; the page says so prominently.
 * `tokenLimit` / `creditLimit`: it reached that limit, so the proxy turned it off. `callLimit`: it
 * used its successful calls; it stays on, but clients get 429 until the limit is raised or usage
 * is reset.
 */
export type UserKeyStatus =
  | "active"
  | "off"
  | "expired"
  | "tokenLimit"
  | "creditLimit"
  | "callLimit";

/** setTimeout's longest delay (about 24.8 days); a later expiry waits for a poll instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The key's state, in the order the proxy refuses a request (proxy/auth.go): turned off, then
 * expired, then the token limit, the credit limit and the call limit. A key off because it
 * reached its token or credit limit (config/apikeys.go turns it off then) reads as that limit, as
 * on the admin's API keys table. An expiry that passed since the last poll counts as expired
 * already.
 */
export function userKeyStatus(key: UserKey, nowSec: number = Date.now() / 1000): UserKeyStatus {
  const limit = limitReachedReason(key);
  if (!key.enabled && limit !== "disabled") return "off";
  if (key.expired || (key.expiresAt > 0 && key.expiresAt <= nowSec)) return "expired";
  if (limit === "disabled") {
    return key.tokenLimit > 0 && key.tokensUsed >= key.tokenLimit ? "tokenLimit" : "creditLimit";
  }
  if (limit === "calls") return "callLimit";
  return "active";
}

/**
 * Renders the caller again the moment `expiresAt` (unix s, 0 = never) passes, so a page left
 * open turns to Expired on time rather than at the next poll.
 */
export function useRerenderAtExpiry(expiresAt: number): void {
  const [, setPassed] = useState(0);
  useEffect(() => {
    const left = expiresAt * 1000 - Date.now();
    if (expiresAt <= 0 || left < 0 || left > MAX_TIMEOUT_MS) return;
    // A little past it: a timer may fire a millisecond early, and the expiry must have passed.
    const timer = setTimeout(() => setPassed((n) => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [expiresAt]);
}
