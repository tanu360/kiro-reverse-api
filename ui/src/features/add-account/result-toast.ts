import type { TFunction } from "@/lib/i18n";
import { toast } from "@/lib/toast";

const RESULT_TOAST_MS = 5200;
const SHOWN_FAILURES = 3;

/** One toast for a batch import: the counts, plus the first failure reasons as the description. */
export function showBatchResult(t: TFunction, added: number, failures: string[]): void {
  if (failures.length === 0) {
    toast.success(t("importSuccess", { count: added }), { duration: RESULT_TOAST_MS });
    return;
  }
  const hidden = failures.length - SHOWN_FAILURES;
  const description = [
    ...failures.slice(0, SHOWN_FAILURES),
    ...(hidden > 0 ? [t("moreFailures", { count: hidden })] : []),
  ].join("; ");
  toast.warning(t("importPartial", { count: added, failed: failures.length }), {
    description,
    duration: RESULT_TOAST_MS,
  });
}
