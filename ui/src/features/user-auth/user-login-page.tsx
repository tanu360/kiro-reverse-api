import { CircleXIcon, Clock01Icon, LogInIcon } from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type JSX, type ReactNode, useRef, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { PasswordInput } from "@/components/shared/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { AuthHeader, AuthLayout, AuthSwitchLink } from "@/features/auth/auth-layout";
import { retrySeconds, useRetryCountdown } from "@/features/auth/rate-limit";
import { useSessionExpired } from "@/features/auth/session-expired";
import { isApiError } from "@/lib/api/errors";
import { errorMessage, serverErrorCode } from "@/lib/api/server-errors";
import { signInWithKey } from "@/lib/api/user-panel";
import { getUserStaySignedIn } from "@/lib/auth/user-session";
import { formatDuration } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { MockDemoKeys } from "./mock-demo-keys";
import { userRedirectTarget } from "./redirect";

/**
 * /user/login: an API key holder signs in with the key to see its own usage. The admin sign-in
 * page's frame, header and form, with the API key in place of the password.
 */
export function UserLoginPage({ redirect }: { redirect?: string }): JSX.Element {
  const { t } = useT("user-auth");
  return (
    <AuthLayout>
      <AuthHeader description={t("subtitle")} title={t("title")} />
      <UserSignInForm
        footer={<AuthSwitchLink label={t("adminLink")} prompt={t("adminPrompt")} to="/login" />}
        redirect={redirect}
      />
    </AuthLayout>
  );
}

/**
 * The admin sign-in form (features/auth/sign-in-form.tsx) for an API key: one field, the same
 * rate-limit countdown, server errors and "Stay signed in". The key lives only in this
 * component's state; signInWithKey stores the session token, never the key. `footer` (the link
 * to the admin sign-in) sits right under the form, above the mock demo keys.
 */
function UserSignInForm({
  redirect,
  footer,
}: {
  redirect?: string;
  footer: ReactNode;
}): JSX.Element {
  const { t, lang } = useT("user-auth");
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(getUserStaySignedIn);
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const retry = useRetryCountdown();
  const locked = retry.seconds > 0;
  const retryNotice = t("auth:rateLimited", { time: formatDuration(retry.seconds, lang) });
  // The lockout's length when it began: the live region reads this once, not every tick.
  const [lockSeconds, setLockSeconds] = useState(0);
  const lockNotice = t("auth:rateLimited", { time: formatDuration(lockSeconds, lang) });
  const inputRef = useRef<HTMLInputElement>(null);
  // Came here because the session ran out: said above the button until the next attempt.
  const session = useSessionExpired("user");

  const signIn = async (typed: string) => {
    if (pending || locked) return;
    setFormError(null);
    session.hide();
    // A pasted key often brings a space or line break along.
    const value = typed.trim();
    if (!value) {
      setFieldError(t("errors:serverError.userKeyRequired"));
      // FieldError is no live region: focus brings the field and its error to a screen reader.
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setPending(true);
    try {
      await signInWithKey(value, remember);
    } catch (error) {
      setPending(false);
      const code = serverErrorCode(error);
      if (isApiError(error) && (error.status === 401 || code === "user_key_required")) {
        setFieldError(
          code === "user_key_required"
            ? t("errors:serverError.userKeyRequired")
            : t("errors:serverError.userKeyInvalid"),
        );
        // Back in the field with the wrong key selected, so pasting replaces it.
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (isApiError(error) && error.status === 429) {
        const seconds = retrySeconds(error);
        setLockSeconds(seconds);
        retry.start(seconds);
      } else if (
        // No answer, or a gateway in front of the proxy answering for it.
        isApiError(error) &&
        (error.status === 0 || (error.status >= 502 && error.status <= 504))
      ) {
        setFormError(t("auth:connectError"));
      } else {
        setFormError(errorMessage(error, t));
      }
      return;
    }
    setKey("");
    const { to, search } = userRedirectTarget(redirect);
    try {
      // Stays pending until the page changes, so a second Enter cannot sign in twice.
      await navigate({ to, search: () => search });
    } finally {
      setPending(false);
    }
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void signIn(key);
  };
  // Mock mode only: a demo key fills the field and signs in, as typing it and pressing Enter.
  const pickDemoKey = (demo: string) => {
    setKey(demo);
    void signIn(demo);
  };

  return (
    <>
      <form autoComplete="off" className="flex flex-col gap-4" noValidate onSubmit={onSubmit}>
        <Field className="w-full items-stretch" invalid={Boolean(fieldError)}>
          <FieldLabel className="sr-only">{t("key")}</FieldLabel>
          <PasswordInput
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            hideLabel={t("hideKey")}
            invalid={Boolean(fieldError)}
            lockIcon
            name="apiKey"
            onChange={(next) => {
              setKey(next);
              if (fieldError) setFieldError(null);
            }}
            placeholder={t("keyPlaceholder")}
            ref={inputRef}
            showLabel={t("showKey")}
            size="lg"
            value={key}
          />
          {fieldError ? <FieldError match>{fieldError}</FieldError> : null}
        </Field>
        <Label className="-my-3 self-start" variant="option">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
          />
          {t("auth:remember")}
        </Label>
        {/* Always rendered, so the notice is announced; empty, it takes back the form's gap. */}
        <div aria-atomic="true" aria-live="polite" className="empty:-mb-4">
          {locked ? (
            // The fixed sr-only notice is read once; the ticking copy is hidden from the region.
            <>
              <span className="sr-only">{lockNotice}</span>
              <Alert aria-hidden="true" role="none" variant="warning">
                <AnimatedIcon icon={Clock01Icon} aria-hidden="true" playOnMount />
                <AlertDescription className="tabular-nums">{retryNotice}</AlertDescription>
              </Alert>
            </>
          ) : null}
        </div>
        {formError ? (
          <Alert variant="error">
            <AnimatedIcon icon={CircleXIcon} aria-hidden="true" playOnMount />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : session.expired ? (
          <Alert data-slot="session-expired" variant="warning">
            <AnimatedIcon icon={Clock01Icon} aria-hidden="true" playOnMount />
            <AlertDescription>{t("errors:sessionExpired")}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          aria-disabled={locked || undefined}
          className="w-full"
          loading={pending}
          loadingText={t("auth:signingIn")}
          size="lg"
          type="submit"
        >
          {pending ? null : <AnimatedIcon icon={LogInIcon} aria-hidden="true" />}
          {t("auth:submit")}
        </Button>
      </form>
      {footer}
      <MockDemoKeys onPick={pickDemoKey} />
    </>
  );
}
