import { type JSX, useEffect, useRef } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

/**
 * The app's toaster: the coss ui toast, stacked at the bottom right, with no stale-language
 * toasts. Toasts keep the text they were created with, so a language switch dismisses the open
 * ones instead of leaving English text in a zh UI.
 */
export function AppToaster(): JSX.Element {
  const { lang } = useT();
  const previousLang = useRef(lang);

  useEffect(() => {
    if (previousLang.current === lang) return;
    previousLang.current = lang;
    toast.dismiss();
  }, [lang]);

  return <ToastProvider />;
}
