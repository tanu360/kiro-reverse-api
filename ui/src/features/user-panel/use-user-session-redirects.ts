import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { markSignInReason } from "@/features/auth/sign-in-reason";
import { subscribeUserSession } from "@/lib/auth/user-session";

/**
 * The key holder's session on /user: an expired one (a 401 from /user/api, or the stored token
 * running out) goes to the key sign-in page, which says the session expired; a sign-out goes
 * there silently.
 */
export function useUserSessionRedirects(): void {
  const router = useRouter();

  useEffect(
    () =>
      subscribeUserSession((_token, reason) => {
        if (reason === "expired") {
          markSignInReason("user", "expired");
          void router.navigate({ to: "/user/login", replace: true });
          return;
        }
        // Replace: Back from the sign-in page must not land on the signed-out panel again.
        if (reason === "signed-out") void router.navigate({ to: "/user/login", replace: true });
      }),
    [router],
  );
}
