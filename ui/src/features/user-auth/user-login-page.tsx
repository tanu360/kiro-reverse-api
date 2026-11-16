import { CircleXIcon, Clock01Icon, LogInIcon } from "@hugeicons/core-free-icons";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type JSX, useRef, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { PasswordInput } from "@/components/shared/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { AuthHeader, AuthLayout } from "@/features/auth/auth-layout";
import { retrySeconds, useRetryCountdown } from "@/features/auth/rate-limit";
import { isApiError } from "@/lib/api/errors";
import { errorMessage, serverErrorCode } from "@/lib/api/server-errors";
import { signInWithKey } from "@/lib/api/user-panel";
import { getUserStaySignedIn } from "@/lib/auth/user-session";
import { formatDuration } from "@/lib/format";
import { fillNodes, useT } from "@/lib/i18n";
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
      <UserSignInForm redirect={redirect} />
      <p className="text-center text-muted-foreground text-sm">
        {fillNodes(t("adminPrompt"), {
          link: (
            <Button render={<Link to="/login" />} variant="link-inline">
              {t("adminLink")}
            </Button>
          ),
        })}
      </p>
    </AuthLayout>
  );
}

/**
 * The admin sign-in form (features/auth/sign-in-form.tsx) for an API key: one field, the same
 * rate-limit countdown, server errors and "Stay signed in". The key lives only in this
 * component's state; signInWithKey stores the session token, never the key.
 */
function UserSignInForm({ redirect }: { redirect?: string }): JSX.Element {
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
  const inputRef = useRef<HTMLInputElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || locked) return;
    setFormError(null);
    // A pasted key often brings a space or line break along.
    const value = key.trim();
    if (!value) {
      setFieldError(t("errors:serverError.userKeyRequired"));
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
        retry.start(retrySeconds(error));
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

  return (
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
      {/* Always rendered, so the notice is announced; empty, it takes back the form's gap. */}
      <div aria-atomic="true" aria-live="polite" className="empty:-mb-4">
        {locked ? (
          <Alert role="none" variant="warning">
            <AnimatedIcon icon={Clock01Icon} aria-hidden="true" playOnMount />
            <AlertDescription className="tabular-nums">{retryNotice}</AlertDescription>
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
        loadingText={t("auth:signingIn")}
        size="lg"
        type="submit"
      >
        {pending ? null : <AnimatedIcon icon={LogInIcon} aria-hidden="true" />}
        {t("auth:submit")}
      </Button>
      <Label className="-mt-3 self-start" variant="option">
        <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        {t("auth:remember")}
      </Label>
    </form>
  );
}
