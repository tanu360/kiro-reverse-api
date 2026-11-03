import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EyeIcon, EyeOffIcon, InfoIcon } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated, subscribeSession } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { AuthHeader, AuthLayout } from "./auth-layout";
import { SignInForm } from "./sign-in-form";

// Long enough to reach the toast's "Open settings" action.
const CHANGE_PASSWORD_TOAST_MS = 10_000;

/** Fira Code when the system has it, else the app's mono stack (index.css --font-mono). */
const PASSWORD_FONT = {
  fontFamily:
    '"Fira Code", "Geist Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/**
 * /setup: shows the generated first-run password from the public GET /first-run, as the old
 * login screen did, above the same sign-in form. The password is never filled in for the user.
 */
export function SetupPage(): JSX.Element {
  const { t } = useT("auth");
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
      <AuthHeader description={t("firstRunPassword")} title={t("setupTitle")} />
      <div className="flex flex-col gap-6">
        <GeneratedPassword
          onRetry={() => void firstRun.refetch()}
          password={password}
          unavailable={firstRun.isError}
        />
        <SignInForm onSignedIn={onSignedIn} />
      </div>
    </AuthLayout>
  );
}

/**
 * The generated password: a small caps label, then an inset well holding the password in mono
 * with a show/hide toggle and the copy button built in, and the "shown until" hint under it.
 */
function GeneratedPassword({
  password,
  unavailable,
  onRetry,
}: {
  password?: string;
  unavailable: boolean;
  onRetry: () => void;
}): JSX.Element {
  const { t } = useT("auth");
  const { t: tShared } = useT();
  const [hidden, setHidden] = useState(false);
  const toggleLabel = hidden ? t("showGeneratedPassword") : t("hideGeneratedPassword");
  const ToggleIcon = hidden ? EyeIcon : EyeOffIcon;

  return (
    <section aria-label={t("firstRunPasswordLabel")} className="flex flex-col gap-2">
      <p
        aria-hidden="true"
        className="font-medium text-[0.6875rem] text-muted-foreground uppercase tracking-[0.08em]"
      >
        {t("adminPasswordLabel")}
      </p>
      <div className="flex min-h-13 items-center gap-1 rounded-xl border bg-muted py-1 ps-4 pe-1 shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)] dark:bg-input/24 dark:shadow-[inset_0_1px_3px_rgb(0_0_0/0.5)]">
        {password ? (
          <>
            <code
              className="min-w-0 flex-1 break-all font-medium text-lg tracking-[0.2em]"
              style={PASSWORD_FONT}
            >
              {hidden ? "•".repeat(password.length) : password}
            </code>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={toggleLabel}
                    aria-pressed={hidden}
                    className="size-10 md:size-8"
                    onClick={() => setHidden((value) => !value)}
                    size="icon"
                    variant="ghost"
                  />
                }
              >
                <ToggleIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup>{toggleLabel}</TooltipPopup>
            </Tooltip>
            <CopyButton label={t("copyPassword")} value={password} />
          </>
        ) : unavailable ? (
          <>
            <p className="min-w-0 flex-1 text-muted-foreground text-sm">
              {t("firstRunUnavailable")}
            </p>
            <Button onClick={onRetry} size="sm" variant="outline">
              {tShared("actions.retry")}
            </Button>
          </>
        ) : (
          <Skeleton className="h-6 w-40" />
        )}
      </div>
      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <InfoIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        {t("firstRunNote")}
      </p>
    </section>
  );
}
