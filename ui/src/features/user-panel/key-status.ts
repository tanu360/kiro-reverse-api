import { useEffect, useState } from "react";
import type { UserKey } from "@/lib/api/user-panel";

/** `off` and `expired` keys get every request refused; the page says so prominently. */
export type UserKeyStatus = "active" | "off" | "expired";

/** setTimeout's longest delay (about 24.8 days); a later expiry waits for a poll instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The key's state, in the admin table's order: a key that is turned off reads as off even when
 * it has also expired. An expiry that passed since the last poll counts as expired already.
 */
export function userKeyStatus(
  key: Pick<UserKey, "enabled" | "expired" | "expiresAt">,
  nowSec: number = Date.now() / 1000,
): UserKeyStatus {
  if (!key.enabled) return "off";
  if (key.expired || (key.expiresAt > 0 && key.expiresAt <= nowSec)) return "expired";
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
