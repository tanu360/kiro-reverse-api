import { useEffect } from "react";
import { useT } from "@/lib/i18n";

/**
 * Sets document.title to "<page> · Kiro Proxy" in the UI language, so browser tabs, history
 * and screen readers can tell the pages apart. A null page leaves the title alone.
 */
export function useDocumentTitle(page: string | null | undefined): void {
  const { t } = useT();
  const title = page ? t("shell.documentTitle", { page }) : null;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}
