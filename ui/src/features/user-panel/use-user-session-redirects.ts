import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { subscribeUserSession } from "@/lib/auth/user-session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

/**
 * The key holder's session on /user: an expired one (a 401 from /user/api, or the stored token
 * running out) toasts once and goes to the key sign-in page; a sign-out goes there silently.
 * Several requests failing together share one toast (one id).
 */
export function useUserSessionRedirects(): void {
  const router = useRouter();
  const { t } = useT();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(
    () =>
      subscribeUserSession((_token, reason) => {
        if (reason === "expired") {
          toast.warning(tRef.current("errors:sessionExpired"), {
            id: "user-session-expired",
            background: true,
          });
          void router.navigate({ to: "/user/login", replace: true });
          return;
        }
        // Replace: Back from the sign-in page must not land on the signed-out panel again.
        if (reason === "signed-out") void router.navigate({ to: "/user/login", replace: true });
      }),
    [router],
  );
}
