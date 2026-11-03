import { useNavigate } from "@tanstack/react-router";
import { LogInIcon, TimerIcon } from "lucide-react";
import { type FormEvent, type JSX, useState } from "react";
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
}: {
  redirect?: string;
  /** Runs after the navigation that follows a successful sign-in. */
  onSignedIn?: () => void;
}): JSX.Element {
  const { t } = useT("auth");
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(getRememberPreference);
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const retry = useRetryCountdown();
  const locked = retry.seconds > 0;

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
      else if (isApiError(error) && error.status === 0) setFormError(t("connectError"));
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
      <Label className="min-h-10 cursor-pointer self-start font-normal">
        <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        {t("remember")}
      </Label>
      <div aria-atomic="true" aria-live="polite">
        {locked ? (
          <Alert role="none" variant="warning">
            <TimerIcon aria-hidden="true" />
            <AlertDescription className="text-foreground">
              {t("rateLimited", { seconds: retry.seconds })}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      {formError ? (
        <Alert variant="error">
          <AlertDescription className="text-foreground">{formError}</AlertDescription>
        </Alert>
      ) : null}
      <Button className="w-full sm:h-10" disabled={pending || locked} size="lg" type="submit">
        {pending ? <Spinner aria-hidden="true" /> : <LogInIcon aria-hidden="true" />}
        {pending ? t("signingIn") : t("submit")}
      </Button>
    </form>
  );
}
