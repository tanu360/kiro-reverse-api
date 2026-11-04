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
      className="group/pw flex flex-col items-center gap-1 text-center"
    >
      {/*
       * The label doubles as the copy hint: "Generated password" at rest, "Click to copy" while
       * the password is hovered or keyboard-focused, then "Copied to clipboard" in green. The
       * three sit in one grid cell and cross-fade, so the line never changes height.
       */}
      <p className="grid text-xs [&>span]:col-start-1 [&>span]:row-start-1 [&>span]:transition-opacity [&>span]:duration-150">
        <span className="text-muted-foreground group-has-[[data-copied]]/pw:opacity-0 group-has-[[data-copy-password]:focus-visible]/pw:opacity-0 group-has-[[data-copy-password]:hover]/pw:opacity-0">
          {t("generatedPasswordLabel")}
        </span>
        <span
          aria-hidden="true"
          className="text-[color-mix(in_oklab,var(--muted-foreground)_55%,var(--primary))] opacity-0 group-has-[[data-copy-password]:not([data-copied]):focus-visible]/pw:opacity-100 group-has-[[data-copy-password]:not([data-copied]):hover]/pw:opacity-100"
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
        // password: a block where each digit tile will be, the same size as the real row, so
        // nothing moves when it arrives.
        <SkulletProvider mode={resolvedTheme} theme={SKELETON_THEME}>
          <Skeleton
            data={password || null}
            label={tShared("state.loading")}
            sample={SAMPLE_PASSWORD}
          >
            {(value) => (
              <div className="flex min-h-12 items-center justify-center">
                <CopyablePassword value={value} />
              </div>
            )}
          </Skeleton>
        </SkulletProvider>
      )}
    </section>
  );
}

/** The digits as two groups of four, like a verification code: "1234 5678". */
const GROUP_SIZE = 4;

/**
 * The password itself is the copy control, drawn as a verification code: one tile per digit in
 * two groups of four. Hovering (or keyboard focus) tints the tiles' edges and digits towards the
 * primary purple, a tile at a time, and the label above reads "Click to copy". A click or tap
 * copies it; the tiles pop one after another and turn green with the label, for two seconds. No
 * toast (the label already says it) and no tooltip (it would cover the label). Screen readers get
 * the password plus "Copy password" as its name and a polite "Password copied" status.
 */
function CopyablePassword({ value }: { value: string }): JSX.Element {
  const { t } = useT("auth");
  const { t: tShared } = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tilesRef = useRef<HTMLSpanElement>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const pop = () => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !tilesRef.current) return;
    tilesRef.current.querySelectorAll<HTMLElement>("[data-tile]").forEach((tile, index) => {
      tile.animate?.(
        [{ transform: "scale(1)" }, { transform: "scale(1.08)" }, { transform: "scale(1)" }],
        { duration: 260, delay: index * 28, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    });
  };

  const onClick = async () => {
    if (!(await copyText(value))) {
      toast.error(tShared("toast.copyFailed"));
      return;
    }
    setCopied(true);
    pop();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_MS);
  };

  // Each group keeps its offset in the password: the keys and the wave delay come from it.
  const groups: { start: number; digits: string[] }[] = [];
  for (let start = 0; start < value.length; start += GROUP_SIZE) {
    groups.push({ start, digits: [...value.slice(start, start + GROUP_SIZE)] });
  }

  return (
    <>
      <button
        className="group/code focus-outline cursor-pointer rounded-xl p-1 transition-transform duration-150 active:scale-[0.98]"
        data-copied={copied ? "" : undefined}
        data-copy-password=""
        onClick={onClick}
        type="button"
      >
        <span aria-hidden="true" className="flex items-center gap-2.5 sm:gap-3" ref={tilesRef}>
          {groups.map(({ start, digits }) => (
            <span className="flex gap-1 sm:gap-1.5" key={start}>
              {digits.map((digit, index) => {
                const position = start + index;
                return (
                  <span
                    className={cn(
                      "flex h-10 w-8 items-center justify-center rounded-lg border bg-card/40 font-semibold text-foreground text-lg tabular-nums sm:h-11 sm:w-9 sm:text-xl",
                      "transition-[border-color,color] duration-200",
                      copied
                        ? "border-success/50 text-success-foreground"
                        : "border-border group-hover/code:border-primary/45 group-hover/code:text-[color-mix(in_oklab,var(--foreground)_55%,var(--primary))] group-focus-visible/code:border-primary/45",
                    )}
                    data-tile=""
                    // A left-to-right wave as the tint comes and goes.
                    key={`${position}-${digit}`}
                    style={{ ...PASSWORD_FONT, transitionDelay: `${position * 18}ms` }}
                  >
                    {digit}
                  </span>
                );
              })}
            </span>
          ))}
        </span>
        <span className="sr-only">{value}</span>{" "}
        <span className="sr-only">{t("copyPassword")}</span>
      </button>
      <span className="sr-only" role="status">
        {copied ? t("passwordCopied") : ""}
      </span>
    </>
  );
}
