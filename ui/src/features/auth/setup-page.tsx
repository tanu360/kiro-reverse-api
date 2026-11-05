import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
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

/** Stands in for the password while it loads, so the skeleton has its exact width. */
const SAMPLE_PASSWORD = "00000000";

/**
 * The app's skeleton tokens (index.css --skeleton and --skeleton-highlight, which switch with
 * the theme) and the md radius, so skullet's bar matches every other skeleton.
 */
const SKELETON_COLORS = { base: "var(--skeleton)", highlight: "var(--skeleton-highlight)" };
const SKELETON_THEME = {
  light: SKELETON_COLORS,
  dark: SKELETON_COLORS,
  radius: "var(--radius-md)",
};

/**
 * /setup: shows the generated first-run password from the public GET /first-run, as the old
 * login screen did, as a line of text above the same sign-in form, and fills it into the form's
 * password field, so signing in is one click. The page shows one input box, not two.
 */
export function SetupPage(): JSX.Element {
  const { t } = useT("auth");
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: "/setup" });
  // staleTime 0: fetched again each time the page shows, so a claimed password never lingers.
  const firstRun = useQuery(firstRunQuery());
  const password = firstRun.data?.password;

  useEffect(() => {
    // Someone signed in elsewhere since the route loaded: the password is gone.
    if (password === "" && !isAuthenticated()) {
      void navigate({ to: "/login", search: { redirect }, replace: true });
    }
  }, [password, navigate, redirect]);

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
        <SignInForm
          redirect={redirect}
          defaultPassword={password || undefined}
          onSignedIn={onSignedIn}
        />
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
      className="group/pw flex flex-col items-center gap-1 text-center"
    >
      {/*
       * The label doubles as the copy hint: "Generated password" at rest, "Click to copy" while
       * the password is hovered or keyboard-focused, then "Copied to clipboard" in green. The
       * three sit in one grid cell and cross-fade, so the line never changes height.
       */}
      <p className="grid text-meta [&>span]:col-start-1 [&>span]:row-start-1 [&>span]:transition-opacity [&>span]:duration-150">
        <span className="text-muted-foreground group-has-[[data-copied]]/pw:opacity-0 group-has-[[data-copy-password]:focus-visible]/pw:opacity-0 group-has-[[data-copy-password]:hover]/pw:opacity-0">
          {t("generatedPasswordLabel")}
        </span>
        <span
          aria-hidden="true"
          className="text-info-foreground opacity-0 group-has-[[data-copy-password]:not([data-copied]):focus-visible]/pw:opacity-100 group-has-[[data-copy-password]:not([data-copied]):hover]/pw:opacity-100"
        >
          {t("clickToCopy")}
        </span>
        <span
          aria-hidden="true"
          className="text-success-foreground opacity-0 group-has-[[data-copied]]/pw:opacity-100"
        >
          {tShared("toast.copied")}
        </span>
      </p>
      {unavailable && !password ? (
        // The message, then "Try again" centred on its own line.
        <div className="flex min-h-10 flex-col items-center justify-center">
          <span className="text-muted-foreground text-sm">{t("firstRunUnavailable")}</span>
          <Button onClick={onRetry} size="sm" variant="ghost">
            {tShared("actions.retry")}
          </Button>
        </div>
      ) : (
        // While it loads (first visit, or after "Try again"), skullet draws the row from a sample
        // password: a bar where the password will be, the same size as the real row, so nothing
        // moves when it arrives.
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
 * The password itself is the copy control: no separate copy icon, no box, just the digits in bold
 * mono. Hovering (or keyboard focus) turns them the accent text purple and the label
 * above reads "Click to copy"; a click or tap copies them and turns the digits and the label green
 * for two seconds. No toast (the label already says it) and no tooltip (it would cover the label).
 * Screen readers get the password plus "Copy password" as its name and a polite "Password copied"
 * status.
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
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_MS);
  };

  return (
    <>
      <button
        className={cn(
          "focus-outline min-w-0 cursor-pointer break-all rounded-md px-2 py-1 font-bold font-mono text-foreground text-xl tabular-nums tracking-widest transition-[color,scale] duration-150 active:scale-[0.98]",
          "hover:text-info-foreground focus-visible:text-info-foreground",
          copied && "text-success-foreground hover:text-success-foreground",
        )}
        data-copied={copied ? "" : undefined}
        data-copy-password=""
        onClick={onClick}
        type="button"
      >
        <span>{value}</span> <span className="sr-only">{t("copyPassword")}</span>
      </button>
      <span className="sr-only" role="status">
        {copied ? t("passwordCopied") : ""}
      </span>
    </>
  );
}
