import { useBlocker } from "@tanstack/react-router";
import { type ConfirmOptions, useConfirm } from "@/components/shared/confirm-dialog";

/**
 * Guards an unsaved draft. While `dirty`, moving to another page asks first (the confirm dialog
 * with `message`; confirming discards the draft) and closing or reloading the tab gets the
 * browser's own leave prompt. A change of search params on the same page is let through.
 */
export function useDraftGuard(dirty: boolean, { message }: { message: ConfirmOptions }): void {
  const confirm = useConfirm();
  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: () => dirty,
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      const discard = await confirm(message);
      return !discard;
    },
  });
}
