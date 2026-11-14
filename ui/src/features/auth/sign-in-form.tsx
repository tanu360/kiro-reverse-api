import { CircleXIcon, Clock01Icon, LogInIcon } from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { isApiError } from "@/lib/api/errors";
import { errorMessage, serverErrorCode } from "@/lib/api/server-errors";
import { completeSignIn, getRememberPreference, signIn } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { redirectTarget } from "@/routes/-search";
import { CodeField } from "./code-field";
import { PasswordField } from "./password-field";
import { retrySeconds, useRetryCountdown } from "./rate-limit";

/**
 * The sign-in form shared by /login and /setup. It never reads the URL: /login passes the
 * validated `redirect`, and /setup carries that same destination. The password lives only in this
 * component's state; signIn stores the token, never the password.
 */
export function SignInForm({
  redirect,
  onSignedIn,
  defaultPassword,
}: {
  redirect?: string;
  /** Runs after the navigation that follows a successful sign-in. */
  onSignedIn?: () => void;
  /** Filled into the password field (/setup: the generated first-run password). */
  defaultPassword?: string;
}): JSX.Element {
  const { t } = useT("auth");
  const navigate = useNavigate();
  const [password, setPassword] = useState(defaultPassword ?? "");
  const [remember, setRemember] = useState(
    () => import.meta.env.VITE_MOCK === "1" || getRememberPreference(),
  );
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const retry = useRetryCountdown();
  const locked = retry.seconds > 0;
  const inputRef = useRef<HTMLInputElement>(null);
  // With two-factor sign-in on, the right password leads to a second step with this challenge.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const finish = async () => {
    setPassword("");
    const { to, search } = redirectTarget(redirect);
    try {
      // Stays pending until the page changes, so a second Enter cannot sign in twice.
      await navigate({ to, search: () => search });
    } finally {
      setPending(false);
    }
    onSignedIn?.();
  };

  /** A failure both steps share: the rate limit, an unreachable proxy, or the server's text. */
  const showSharedError = (error: unknown) => {
    if (isApiError(error) && error.status === 429) retry.start(retrySeconds(error));
    // No answer, or a gateway in front of the proxy answering for it (502 / 503 / 504, whose
    // body is only the status text, e.g. "Bad Gateway"): the proxy cannot be reached.
    else if (
      isApiError(error) &&
      (error.status === 0 || (error.status >= 502 && error.status <= 504))
    )
      setFormError(t("connectError"));
    else setFormError(errorMessage(error, t));
  };

  const backToPassword = (notice?: string) => {
    setChallenge(null);
    setCode("");
    setRecovery(false);
    setFieldError(null);
    setFormError(notice ?? null);
  };

  const onSubmitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || locked || !challenge) return;
    setFormError(null);
    const value = code.trim();
    if (!value) {
      setFieldError(recovery ? t("recoveryRequired") : t("codeRequired"));
      return;
    }
    setFieldError(null);
    setPending(true);
    try {
      await completeSignIn(
        challenge,
        recovery ? { recoveryCode: value } : { code: value },
        remember,
      );
    } catch (error) {
      setPending(false);
      const reason = serverErrorCode(error);
      if (reason === "totp_challenge_expired") {
        backToPassword(t("challengeExpired"));
        return;
      }
      if (isApiError(error) && error.status === 401) {
        setFieldError(
          reason === "totp_reused"
            ? t("codeReused")
            : recovery
              ? t("recoveryWrong")
              : t("codeWrong"),
        );
        codeRef.current?.focus();
        codeRef.current?.select();
        return;
      }
      showSharedError(error);
      return;
    }
    await finish();
  };

  useEffect(() => {
    // The default can arrive after the form mounts (a slow first-run fetch). Fill it in then,
    // unless something was typed already.
    if (defaultPassword) setPassword((current) => current || defaultPassword);
  }, [defaultPassword]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || locked) return;
    setFormError(null);
    if (!password) {
      setFieldError(t("passwordRequired"));
      return;
    }
    setFieldError(null);
    setPending(true);
    let result: Awaited<ReturnType<typeof signIn>>;
    try {
      result = await signIn(password, remember);
    } catch (error) {
      setPending(false);
      if (isApiError(error) && error.status === 401) {
        setFieldError(t("error"));
        // Back in the field with the wrong text selected, so retyping replaces it (and a phone
        // brings its keyboard back) without deleting hidden characters first.
        inputRef.current?.focus();
        inputRef.current?.select();
      } else showSharedError(error);
      return;
    }
    if (result.kind === "two-factor") {
      setPending(false);
      // The password did its part; it does not wait in memory for the code.
      setPassword("");
      setChallenge(result.challenge);
      setCode("");
      return;
    }
    await finish();
  };

  if (challenge) {
    return (
      <form autoComplete="on" className="flex flex-col gap-4" noValidate onSubmit={onSubmitCode}>
        <p className="text-muted-foreground text-sm">
          {recovery ? t("recoveryPrompt") : t("codePrompt")}
        </p>
        <CodeField
          error={fieldError}
          key={recovery ? "recovery" : "code"}
          onChange={(next) => {
            setCode(next);
            if (fieldError) setFieldError(null);
          }}
          recovery={recovery}
          ref={codeRef}
          value={code}
        />
        <div aria-atomic="true" aria-live="polite" className="empty:-mb-4">
          {locked ? (
            <Alert role="none" variant="warning">
              <AnimatedIcon icon={Clock01Icon} aria-hidden="true" playOnMount />
              <AlertDescription>{t("rateLimited", { seconds: retry.seconds })}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        {formError ? (
          <Alert variant="error">
            <AnimatedIcon icon={CircleXIcon} aria-hidden="true" playOnMount />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          aria-disabled={locked || undefined}
          className="w-full"
          loading={pending}
          loadingText={t("verifying")}
          size="lg"
          type="submit"
        >
          {pending ? null : <AnimatedIcon icon={LogInIcon} aria-hidden="true" />}
          {t("verify")}
        </Button>
        <div className="-mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Button
            onClick={() => {
              setRecovery((current) => !current);
              setCode("");
              setFieldError(null);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            {recovery ? t("useCode") : t("useRecovery")}
          </Button>
          <Button onClick={() => backToPassword()} size="sm" type="button" variant="ghost">
            {t("backToPassword")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form autoComplete="on" className="flex flex-col gap-4" noValidate onSubmit={onSubmit}>
      {/* Lets password managers file the saved password under a user name. */}
      <input autoComplete="username" hidden name="username" readOnly value="admin" />
      <PasswordField
        error={fieldError}
        onChange={(next) => {
          setPassword(next);
          if (fieldError) setFieldError(null);
        }}
        ref={inputRef}
        value={password}
      />
      {/* Always rendered, so the notice is announced; empty, it takes back the form's gap. */}
      <div aria-atomic="true" aria-live="polite" className="empty:-mb-4">
        {locked ? (
          // No role: the live region round it announces the countdown politely.
          <Alert role="none" variant="warning">
            <AnimatedIcon icon={Clock01Icon} aria-hidden="true" playOnMount />
            <AlertDescription>{t("rateLimited", { seconds: retry.seconds })}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {formError ? (
        <Alert variant="error">
          <AnimatedIcon icon={CircleXIcon} aria-hidden="true" playOnMount />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      {/*
       * The primary button (components/ui/button.tsx lg): the field's height, full width. While
       * it signs in, the Button's spinner takes the icon's place and it stays focusable. While
       * the rate limit holds, aria-disabled (not native disabled) dims it and keeps focus on it,
       * so a click that set off the lock does not drop focus to the page; onSubmit returns early.
       * The Button keeps aria-disabled on while loading, whatever this prop says.
       */}
      <Button
        aria-disabled={locked || undefined}
        className="w-full"
        loading={pending}
        loadingText={t("signingIn")}
        size="lg"
        type="submit"
      >
        {pending ? null : <AnimatedIcon icon={LogInIcon} aria-hidden="true" />}
        {t("submit")}
      </Button>
      {/*
       * A quiet option under the button (the Label's option look). -mt-3 pulls it up so the box
       * sits about 16 px under the button, while the row keeps its 40 px target.
       */}
      <Label className="-mt-3 self-start" variant="option">
        <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        {t("remember")}
      </Label>
    </form>
  );
}
