import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useEffect } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated, subscribeSession } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { AuthLayout } from "./auth-layout";
import { SignInForm } from "./sign-in-form";

// Long enough to reach the toast's "Open settings" action.
const CHANGE_PASSWORD_TOAST_MS = 10_000;

/**
 * /setup: shows the generated first-run password from the public GET /first-run, as the old
 * login screen did, above the same sign-in form. The password is never filled in for the user.
 */
export function SetupPage(): JSX.Element {
  const { t } = useT("auth");
  const { t: tShared } = useT();
  const navigate = useNavigate();
  // staleTime 0: fetched again each time the page shows, so a claimed password never lingers.
  const firstRun = useQuery(firstRunQuery());
  const password = firstRun.data?.password;

  useEffect(() => {
    // Someone signed in elsewhere since the route loaded: the password is gone.
    if (password === "" && !isAuthenticated()) {
      void navigate({ to: "/login", replace: true });
    }
  }, [password, navigate]);

  const onSignedIn = () => {
    const id = toast.info(t("changePasswordToast"), {
      duration: CHANGE_PASSWORD_TOAST_MS,
      action: { label: t("openSettings"), onClick: () => void navigate({ to: "/settings" }) },
    });
    // The hint only makes sense while signed in. When this session ends (sign-out, expiry,
    // restore) it goes too, so it never sits on the sign-in page pointing at Settings. The
    // listener removes itself then; dismissing a toast that already timed out does nothing.
    const stop = subscribeSession((session) => {
      if (session) return;
      toast.dismiss(id);
      stop();
    });
  };

  return (
    <AuthLayout>
      <CardHeader>
        <CardTitle render={(props) => <h1 {...props} />}>{t("setupTitle")}</CardTitle>
        <CardDescription>{t("firstRunPassword")}</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-5">
        <section
          aria-label={t("firstRunPasswordLabel")}
          className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3"
        >
          <div className="flex min-h-10 items-center justify-between gap-2">
            {password ? (
              <>
                <code className="min-w-0 break-all font-mono font-semibold text-2xl tracking-widest">
                  {password}
                </code>
                <CopyButton label={t("copyPassword")} value={password} variant="outline" />
              </>
            ) : firstRun.isError ? (
              <>
                <p className="text-muted-foreground text-sm">{t("firstRunUnavailable")}</p>
                <Button onClick={() => void firstRun.refetch()} size="sm" variant="outline">
                  {tShared("actions.retry")}
                </Button>
              </>
            ) : (
              <Skeleton className="h-8 w-40" />
            )}
          </div>
          <p className="text-muted-foreground text-xs">{t("firstRunNote")}</p>
        </section>
        <SignInForm onSignedIn={onSignedIn} />
      </CardPanel>
    </AuthLayout>
  );
}
