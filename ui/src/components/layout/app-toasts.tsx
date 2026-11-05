import { useRouterState } from "@tanstack/react-router";
import { type JSX, useEffect, useRef } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useT } from "@/lib/i18n";
import { syncToastPath, toast } from "@/lib/toast";

/** Phones (below sm): toasts drop in at the top, clear of bottom sheets, the nav and the batch bar. */
const PHONE_TOAST_QUERY = "(max-width: 639px)";

/**
 * The app's toaster: the coss ui toast, at the top centre on phones and the bottom right from sm
 * up, with no stale-language toasts. Toasts keep the text they were created with, so a language
 * switch dismisses the open ones instead of leaving English text in a zh UI.
 */
export function AppToaster(): JSX.Element {
  const { lang } = useT();
  const isPhone = useMediaQuery(PHONE_TOAST_QUERY);
  const previousLang = useRef(lang);

  useEffect(() => {
    if (previousLang.current === lang) return;
    previousLang.current = lang;
    toast.dismiss();
  }, [lang]);

  return <ToastProvider position={isPhone ? "top-center" : "bottom-right"} />;
}

/**
 * Closes the toasts that point at the page the app just reached (ToastOptions.hideOnPath), on
 * every navigation. AppToaster sits outside the router, so the app shell calls this inside it.
 */
export function useToastPathSync(): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    syncToastPath(pathname);
  }, [pathname]);
}
