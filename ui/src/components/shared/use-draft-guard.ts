import { useBlocker } from "@tanstack/react-router";
import { type ConfirmOptions, useConfirm } from "@/components/shared/confirm-dialog";
import { isAuthenticated } from "@/lib/auth/session";

/** Sign-in and first-run setup: where sign-out, an expired session and a restore send the user. */
const SESSION_EXIT = /\/(login|setup)\/?$/;

/**
 * Guards an unsaved draft. While `dirty`, moving to another page asks first (the confirm dialog
 * with `message`; confirming discards the draft) and closing or reloading the tab gets the
 * browser's own leave prompt. A change of search params on the same page is let through, and so
 * is any move once the session has ended: sign-out, an expired session and a backup restore must
 * always reach the sign-in page, or the user would be left on a page whose every request fails.
 */
export function useDraftGuard(dirty: boolean, { message }: { message: ConfirmOptions }): void {
  const confirm = useConfirm();
  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: () => dirty && isAuthenticated(),
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (SESSION_EXIT.test(next.pathname) || !isAuthenticated()) return false;
      const discard = await confirm(message);
      return !discard;
    },
  });
}
