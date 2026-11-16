import type { UserKey } from "@/lib/api/user-panel";

/** `off` and `expired` keys get every request refused; the page says so prominently. */
export type UserKeyStatus = "active" | "off" | "expired";

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
