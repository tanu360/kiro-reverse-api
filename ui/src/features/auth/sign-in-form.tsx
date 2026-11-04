import { useNavigate } from "@tanstack/react-router";
import { CircleXIcon, ClockIcon, LogInIcon } from "lucide-react";
import { type FormEvent, type JSX, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { isApiError } from "@/lib/api/errors";
import { errorMessage } from "@/lib/api/server-errors";
import { getRememberPreference, signIn } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { redirectTarget } from "@/routes/-search";
import { PasswordField } from "./password-field";
import { retrySeconds, useRetryCountdown } from "./rate-limit";

/**
 * The sign-in form shared by /login and /setup. It never reads the URL: /login passes the
 * validated `redirect`, /setup passes nothing (Overview). The password lives only in this
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
  const [remember, setRemember] = useState(getRememberPreference);
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const retry = useRetryCountdown();
  const locked = retry.seconds > 0;

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
    try {
      await signIn(password, remember);
    } catch (error) {
      setPending(false);
      if (isApiError(error) && error.status === 401) setFieldError(t("error"));
      else if (isApiError(error) && error.status === 429) retry.start(retrySeconds(error));
      // No answer, or a gateway in front of the proxy answering for it (502 / 503 / 504, whose
      // body is only the status text, e.g. "Bad Gateway"): the proxy cannot be reached.
      else if (
        isApiError(error) &&
        (error.status === 0 || (error.status >= 502 && error.status <= 504))
      )
        setFormError(t("connectError"));
      else setFormError(errorMessage(error, t));
      return;
    }
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
        value={password}
      />
      {/* Always rendered, so the notice is announced; empty, it takes back the form's gap. */}
      <div aria-atomic="true" aria-live="polite" className="empty:-mb-4">
        {locked ? (
          // No role: the live region round it announces the countdown politely.
          <Alert role="none" variant="warning">
            <ClockIcon aria-hidden="true" />
            <AlertDescription>{t("rateLimited", { seconds: retry.seconds })}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {formError ? (
        <Alert variant="error">
          <CircleXIcon aria-hidden="true" />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      {/* The primary button (components/ui/button.tsx lg): the field's height, full width. */}
      <Button className="w-full" disabled={pending || locked} size="lg" type="submit">
        {pending ? <Spinner aria-hidden="true" /> : <LogInIcon aria-hidden="true" />}
        {pending ? t("signingIn") : t("submit")}
      </Button>
      {/*
       * A quiet option under the button: 16 px box, 14 px muted text at every size. -mt-3 pulls
       * it up so the box sits about 16 px under the button, while the row keeps its 40 px target.
       */}
      <Label className="-mt-3 min-h-10 cursor-pointer self-start font-normal text-muted-foreground text-sm/5">
        <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        {t("remember")}
      </Label>
    </form>
  );
}
