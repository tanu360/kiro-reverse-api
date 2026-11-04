import { useNavigate } from "@tanstack/react-router";
import { CircleXIcon, ClockIcon, LogInIcon, type LucideIcon } from "lucide-react";
import { type FormEvent, type JSX, type ReactNode, useEffect, useState } from "react";
import { BadgeIcon, type BadgeTone, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { isApiError } from "@/lib/api/errors";
import { errorMessage } from "@/lib/api/server-errors";
import { getRememberPreference, signIn } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { redirectTarget } from "@/routes/-search";
import { PasswordField } from "./password-field";
import { retrySeconds, useRetryCountdown } from "./rate-limit";

/**
 * A form notice in the style of a soft tag: the submit button's width and corner radius (full
 * width, rounded-lg, so the two line up), the tone's light fill (badgeVariants soft), regular
 * weight text in the tone, and a duotone disc icon (a light circle in the tone with the glyph in
 * the full tone colour, not knocked out in white). A long message wraps inside it.
 */
function FormNotice({
  tone,
  icon,
  role,
  className,
  children,
}: {
  tone: BadgeTone;
  icon: LucideIcon;
  role?: "alert";
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        badgeVariants({ size: "lg", tone, variant: "soft" }),
        // The soft fill the notice was designed with (11 %, 18 % dark), a step over the pills' 8 %.
        "bg-[color-mix(in_oklab,var(--badge-tint)_11%,transparent)] dark:bg-[color-mix(in_oklab,var(--badge-tint)_18%,transparent)]",
        "h-auto min-h-9 w-full items-start justify-start gap-2 whitespace-normal rounded-lg px-3 py-2 text-left font-normal leading-5",
        // Duotone disc, a touch larger than the text.
        "[--badge-dot:color-mix(in_oklab,var(--badge-disc)_28%,transparent)] [--badge-glyph:var(--badge-disc)] [&_svg]:mt-px [&_svg:not([class*='size-'])]:size-4.5",
        className,
      )}
      role={role}
    >
      <BadgeIcon icon={icon} />
      <span>{children}</span>
    </div>
  );
}

/**
 * The error notice's red, a vivid tag red (after a reference design): the pink fill and the icon
 * use #ff3638 itself; the text is #d41d24, the nearest red that keeps 4.5:1 on that fill (#ff3638
 * text would be 3.1:1), and #ff6b6f on the dark theme's fill (6.5:1).
 */
const ERROR_RED =
  "[--badge-disc:#ff3638] [--badge-tint:#ff3638] [--badge-fg:#d41d24] dark:[--badge-fg:#ff6b6f]";

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
      {/* A quiet option: 16 px box, 14 px muted text at every size. */}
      <Label className="min-h-10 cursor-pointer self-start font-normal text-muted-foreground text-sm/5">
        <Checkbox
          // Flat sign-in pages: no drop shadow (the ::before layer only draws one).
          className="size-4 shadow-none before:hidden"
          checked={remember}
          onCheckedChange={(checked) => setRemember(checked === true)}
        />
        {t("remember")}
      </Label>
      {/* Always rendered, so the notice is announced; empty, it takes back the form's gap. */}
      <div aria-atomic="true" aria-live="polite" className="empty:-mb-4">
        {locked ? (
          <FormNotice icon={ClockIcon} tone="warning">
            {t("rateLimited", { seconds: retry.seconds })}
          </FormNotice>
        ) : null}
      </div>
      {formError ? (
        <FormNotice className={ERROR_RED} icon={CircleXIcon} role="alert" tone="destructive">
          {formError}
        </FormNotice>
      ) : null}
      {/*
       * The primary button with a faint film grain (index.css grain-overlay, at half its default
       * strength) that gives the fill some texture, under the label. It keeps the coss lift the
       * app buttons dropped (a soft primary shadow and a 1 px inner highlight), its icon at 80 %,
       * and no scale layer (will-change), which would re-rasterise the label.
       */}
      <Button
        // 44 px on phones and touch screens, 40 px from sm up: the password field's height.
        className="grain-overlay h-11 w-full shadow-primary/24 shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [--grain-overlay-opacity:0.1] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none sm:h-10 pointer-coarse:h-11 [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-auto [&_svg:not([class*='opacity-'])]:opacity-80"
        disabled={pending || locked}
        size="lg"
        type="submit"
      >
        {pending ? <Spinner aria-hidden="true" /> : <LogInIcon aria-hidden="true" />}
        {pending ? t("signingIn") : t("submit")}
      </Button>
    </form>
  );
}
