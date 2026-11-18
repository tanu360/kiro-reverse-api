import type { AddedAccountRef } from "@/lib/api/types";
import { joinList, type TFunction } from "@/lib/i18n";

const SHOWN_FAILURES = 3;

/** What one saved login says: a new account, or a stored one the login updated. */
export function savedText(t: TFunction, account: AddedAccountRef, name: string): string {
  return t(account.updated ? "updatedExisting" : "success", { name });
}

/**
 * What a batch import says, as one line: the counts, then the first failure reasons; with
 * nothing added, the reasons alone. An item that matched a stored account updated it instead of
 * adding one, and is counted apart.
 */
export function batchResultText(
  t: TFunction,
  refs: readonly AddedAccountRef[],
  failures: readonly string[],
): string {
  const join = (first: string, second: string | undefined) =>
    second ? t("common:text.joinSentences", { first, second }) : first;
  const updated = refs.filter((ref) => ref.updated).length;
  const added = refs.length - updated;
  const updatedNote = updated > 0 ? t("importUpdated", { count: updated }) : undefined;
  if (failures.length === 0) {
    if (added === 0 && updatedNote) return updatedNote;
    return join(t("importSuccess", { count: added }), updatedNote);
  }
  const hidden = failures.length - SHOWN_FAILURES;
  const reasons = joinList(t, [
    ...failures.slice(0, SHOWN_FAILURES),
    ...(hidden > 0 ? [t("moreFailures", { count: hidden })] : []),
  ]);
  if (refs.length === 0) return reasons;
  return join(
    join(t("importPartial", { count: added, failed: failures.length }), updatedNote),
    reasons,
  );
}
