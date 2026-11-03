import { type JSX, type ReactNode, useEffect, useRef } from "react";
import { type ToastPosition, ToastProvider } from "@/components/ui/toast";
import { useIsMobile } from "@/hooks/use-media-query";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

/**
 * Where toasts go. On phones, dialogs open as bottom drawers and confirms as bottom sheets, so
 * toasts sit at the top, where they cannot cover a drawer's buttons. They start below the
 * 48 px sticky header, so the sidebar and search buttons stay usable while a toast shows.
 */
export function toastPosition(isMobile: boolean): ToastPosition {
  return isMobile ? "top-center" : "bottom-right";
}

const PHONE_VIEWPORT_CLASS = "[--toast-offset-top:--spacing(10)]";

/**
 * The app's toast provider: translated region and close labels, a position that follows the
 * phone breakpoint, and no stale-language toasts. Toasts keep the text they were created with,
 * so a language switch dismisses the open ones instead of leaving English text in a zh UI.
 */
export function AppToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const { t, lang } = useT();
  const isMobile = useIsMobile();
  const previousLang = useRef(lang);

  useEffect(() => {
    if (previousLang.current === lang) return;
    previousLang.current = lang;
    toast.dismiss();
  }, [lang]);

  return (
    <ToastProvider
      closeLabel={t("shell.toast.dismiss")}
      limit={5}
      position={toastPosition(isMobile)}
      viewportClassName={isMobile ? PHONE_VIEWPORT_CLASS : undefined}
      viewportLabel={t("shell.notifications")}
    >
      {children}
    </ToastProvider>
  );
}
