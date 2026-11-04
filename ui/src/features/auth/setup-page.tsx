import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useEffect, useRef, useState } from "react";
import { Skeleton, SkulletProvider } from "skullet/react";
import { useTheme } from "@/components/layout/theme-provider";
import { Button } from "@/components/ui/button";
import { firstRunQuery } from "@/lib/api/session";
import { isAuthenticated, subscribeSession } from "@/lib/auth/session";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AuthHeader, AuthLayout } from "./auth-layout";
import { SignInForm } from "./sign-in-form";

// Long enough to reach the toast's "Open settings" action.
const CHANGE_PASSWORD_TOAST_MS = 10_000;

/** How long the password stays green after a copy (components/shared/copy-button.tsx). */
const COPIED_MS = 2000;

/** The app's mono stack (index.css --font-mono, self-hosted Fira Code). */
const PASSWORD_FONT = { fontFamily: "var(--font-mono)" };

/** Stands in for the password while it loads, so the skeleton has its exact width. */
const SAMPLE_PASSWORD = "00000000";

/** The app's own skeleton tints (components/ui/skeleton.tsx): foreground at 8%, a soft sheen. */
const SKELETON_THEME = {
  light: { base: "rgb(24 24 27 / 0.08)", highlight: "rgb(255 255 255 / 0.64)" },
  dark: { base: "rgb(255 255 255 / 0.08)", highlight: "rgb(255 255 255 / 0.04)" },
  radius: "6px",
};

/**
 * /setup: shows the generated first-run password from the public GET /first-run, as the old
 * login screen did, as a line of text above the same sign-in form, and fills it into the form's
 * password field, so signing in is one click. The page shows one input box, not two.
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
      <div className="flex flex-col gap-4">
        <GeneratedPassword
          onRetry={() => void firstRun.refetch()}
          password={password}
          // Only once nothing is loading: while "Try again" fetches, the skeleton shows instead.
          unavailable={firstRun.isError && !firstRun.isFetching}
        />
        <SignInForm defaultPassword={password || undefined} onSignedIn={onSignedIn} />
      </div>
    </AuthLayout>
  );
}

/**
 * The generated password, centred and set as text, not as a second input: a small label, then
 * the password large in mono with a copy button. The sign-in field below already holds it.
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
  const { resolvedTheme } = useTheme();

  return (
    <section
      aria-label={t("firstRunPasswordLabel")}
      className="flex flex-col items-center gap-1 text-center"
    >
      <p className="text-muted-foreground text-xs">{t("generatedPasswordLabel")}</p>
      {unavailable && !password ? (
        // The message, then "Try again" centred on its own line; no hover underline.
        <div className="flex min-h-10 flex-col items-center justify-center">
          <span className="text-muted-foreground text-sm">{t("firstRunUnavailable")}</span>
          <Button
            className="h-10 px-2 hover:no-underline data-pressed:no-underline sm:h-10 md:h-8"
            onClick={onRetry}
            size="sm"
            variant="link"
          >
            {tShared("actions.retry")}
          </Button>
        </div>
      ) : (
        // While it loads (first visit, or after "Try again"), skullet draws the row from a sample
        // password: a bar where the password will be and a block for the copy button, the same
        // size as the real row, so nothing moves when it arrives.
        <SkulletProvider mode={resolvedTheme} theme={SKELETON_THEME}>
          <Skeleton
            data={password || null}
            label={tShared("state.loading")}
            sample={SAMPLE_PASSWORD}
          >
            {(value) => (
              <div className="flex min-h-10 items-center justify-center">
                <CopyablePassword value={value} />
              </div>
            )}
          </Skeleton>
        </SkulletProvider>
      )}
    </section>
  );
}

/**
 * The password itself is the copy control: no separate copy icon. Hovering tints it a little
 * towards the primary purple on a faint fill; a click or tap copies it, toasts, and turns it green
 * for two seconds. No tooltip: it would cover the label above. Its accessible name keeps the
 * password and adds "Copy password".
 */
function CopyablePassword({ value }: { value: string }): JSX.Element {
  const { t } = useT("auth");
  const { t: tShared } = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = async () => {
    if (!(await copyText(value))) {
      toast.error(tShared("toast.copyFailed"));
      return;
    }
    toast.success(t("passwordCopied"));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_MS);
  };

  return (
    <button
      className={cn(
        "focus-outline min-w-0 cursor-pointer break-all rounded-md px-2 py-1 font-semibold text-foreground text-xl tracking-[0.18em] transition-colors duration-150",
        "hover:bg-accent hover:text-[color-mix(in_oklab,var(--foreground)_72%,var(--primary))]",
        copied && "text-success-foreground hover:text-success-foreground",
      )}
      data-copied={copied ? "" : undefined}
      onClick={onClick}
      style={PASSWORD_FONT}
      type="button"
    >
      <span>{value}</span> <span className="sr-only">{t("copyPassword")}</span>
    </button>
  );
}
