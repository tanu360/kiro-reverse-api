import { useEffect, useState } from "react";

/** The admin's sign-in (/login) or a key holder's (/user/login). */
type SignInPage = "admin" | "user";

const expired = new Set<SignInPage>();

/**
 * A session that ran out says so on the sign-in page it leads to, not in a toast: the session
 * redirect marks it just before it goes there.
 */
export function markSessionExpired(page: SignInPage): void {
  expired.add(page);
}

/**
 * On the sign-in form: whether it came here because the session expired, and a way to hide that
 * notice (the next sign-in attempt). The mark is taken when the form mounts, so a later visit to
 * the page does not say it again.
 */
export function useSessionExpired(page: SignInPage): { expired: boolean; hide: () => void } {
  const [shown, setShown] = useState(() => expired.has(page));
  useEffect(() => {
    expired.delete(page);
  }, [page]);
  return { expired: shown, hide: () => setShown(false) };
}
