import { type JSX, useEffect, useRef } from "react";
import { NotchToaster } from "@/components/ui/notch-toaster";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

/**
 * The app's toaster: one notch island with translated region and close labels, and no
 * stale-language toasts. Toasts keep the text they were created with, so a language switch
 * dismisses the open ones instead of leaving English text in a zh UI.
 *
 * It hangs top-centre from the sticky header (see the notch block in index.css), so it never
 * covers the header's buttons. On phones, dialogs open as bottom drawers and confirms as bottom
 * sheets, so a toast at the top cannot cover their buttons either.
 */
export function AppToaster(): JSX.Element {
  const { t, lang } = useT();
  const previousLang = useRef(lang);

  useEffect(() => {
    if (previousLang.current === lang) return;
    previousLang.current = lang;
    toast.dismiss();
  }, [lang]);

  return (
    <NotchToaster
      closeLabel={t("shell.toast.dismiss")}
      mode="attached"
      position="top-center"
      regionLabel={t("shell.notifications")}
    />
  );
}
