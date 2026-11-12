import type { AddedAccountRef } from "@/lib/api/types";
import { joinList, type TFunction } from "@/lib/i18n";
import { toast } from "@/lib/toast";

const RESULT_TOAST_MS = 5200;
const SHOWN_FAILURES = 3;

/** The toast title for one saved login: a new account, or a stored one the login updated. */
export function savedTitle(t: TFunction, account: AddedAccountRef, name: string): string {
  return t(account.updated ? "updatedExisting" : "success", { name });
}

/**
 * One toast for a batch import: the counts, plus the first failure reasons as the description.
 * An item that matched a stored account updated it instead of adding one, and is counted apart.
 */
export function showBatchResult(
  t: TFunction,
  refs: readonly AddedAccountRef[],
  failures: string[],
): void {
  const updated = refs.filter((ref) => ref.updated).length;
  const added = refs.length - updated;
  const updatedNote = updated > 0 ? t("importUpdated", { count: updated }) : undefined;
  if (failures.length === 0) {
    const onlyUpdates = added === 0 && updatedNote !== undefined;
    toast.success(onlyUpdates ? updatedNote : t("importSuccess", { count: added }), {
      description: onlyUpdates ? undefined : updatedNote,
      duration: RESULT_TOAST_MS,
    });
    return;
  }
  const hidden = failures.length - SHOWN_FAILURES;
  const reasons = joinList(t, [
    ...failures.slice(0, SHOWN_FAILURES),
    ...(hidden > 0 ? [t("moreFailures", { count: hidden })] : []),
  ]);
  toast.warning(t("importPartial", { count: added, failed: failures.length }), {
    description: updatedNote ? `${updatedNote} ${reasons}` : reasons,
    duration: RESULT_TOAST_MS,
  });
}
