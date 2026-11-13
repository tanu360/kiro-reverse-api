import { ArrowUpRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, type Ref, useEffect, useId, useRef } from "react";
import { AwsLogo, GithubLogo, GoogleLogo, MicrosoftLogo } from "@/components/shared/brand-logos";
import { CopyButton } from "@/components/shared/copy-button";
import { OpenLinkButton } from "@/components/shared/open-link-button";
import { ROW_DESCRIPTION } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A sign-in link as one quiet line instead of a field (no box around it): the label, then the
 * URL in mono cut to a single line (Open and Copy carry the full address), with an open and a
 * copy icon at its end, as in a CopyField's addon. A long OAuth URL no longer fills the step.
 */
export function UrlBox({ label, url }: { label: string; url: string }): JSX.Element {
  const { t } = useT("add-account");
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <span className="font-medium text-foreground text-sm">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">
          {url}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <OpenLinkButton href={url} label={t("openLink")} size="icon-sm" variant="quiet" />
          <CopyButton label={t("copyLink")} size="icon-sm" value={url} variant="quiet" />
        </div>
      </div>
    </div>
  );
}

/**
 * A link out of the dialog as plain text: no fill, no border and no underline at rest or on
 * hover, where only the colour turns to the primary. Opens in a new tab.
 */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  return (
    <a
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-sm font-medium text-foreground text-sm outline-none transition-colors hover:text-primary focus-outline [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        className,
      )}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

/**
 * A page to visit inside a guide step: the site's logo, the address, and a small arrow that says
 * it opens elsewhere, as one plain link on the step's line.
 */
export function GuideLink({
  href,
  logo,
  children,
}: {
  href: string;
  /** The site's brand mark (the Kiro or AWS logo), before the address. */
  logo: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    // gap-1: the 4 px between the logo and the address matches the word space before the
    // logo, so the mark sits evenly between the step's text and the link's.
    <ExternalLink className="gap-1 align-bottom" href={href}>
      {logo}
      {children}
      <HugeiconsIcon
        aria-hidden="true"
        className="size-3 text-muted-foreground"
        icon={ArrowUpRight01Icon}
      />
    </ExternalLink>
  );
}

/** A sign-in provider's own logo, before its name in a picker. */
export function ProviderLogo({ provider }: { provider: string }): JSX.Element | null {
  switch (provider) {
    case "BuilderId":
    case "Enterprise":
      return <AwsLogo className="size-4" />;
    case "Google":
      return <GoogleLogo className="size-4" />;
    case "Github":
      return <GithubLogo className="size-4" />;
    case "Microsoft":
      return <MicrosoftLogo className="size-4" />;
    default:
      return null;
  }
}

/**
 * Label, control, then the hint, wired together by Base UI Field. While the field is invalid its
 * error takes the hint's place, so the line under the control says what to fix.
 */
export function FormField({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const invalid = Boolean(error);
  return (
    <Field className={cn("w-full", className)} invalid={invalid}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {hint && !invalid ? <FieldDescription>{hint}</FieldDescription> : null}
      <FieldError match={invalid}>{error}</FieldError>
    </Field>
  );
}

/**
 * A short note in the hint style (the FieldDescription look) that belongs to the step, not to one
 * field: an extra sentence about the method, or a summary of what an earlier step chose.
 */
export function FlowNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className={ROW_DESCRIPTION}>{children}</p>;
}

/** Numbered guide steps: each item starts with its number in a small ring (CSS counters). */
const GUIDE_STEPS =
  "[counter-reset:flow-guide] *:relative *:ps-7 *:[counter-increment:flow-guide] *:before:absolute *:before:start-0 *:before:top-0.5 *:before:flex *:before:size-4.5 *:before:items-center *:before:justify-center *:before:rounded-full *:before:border *:before:border-border *:before:bg-card *:before:font-semibold *:before:text-2xs *:before:text-foreground *:before:content-[counter(flow-guide)]";

/**
 * Where to find the value a flow asks for: a soft inset box with a heading in the form-label
 * style over numbered steps (or, with `list`, bullet points) in muted body text. Items carry host
 * and file names in Code.
 */
export function FlowGuide({
  title,
  list = false,
  children,
}: {
  title: ReactNode;
  /** Bullet points instead of numbered steps. */
  list?: boolean;
  /** The `<li>` items. */
  children: ReactNode;
}): JSX.Element {
  const id = useId();
  const List = list ? "ul" : "ol";
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border-subtle bg-surface-inset px-4 py-3.5"
    >
      <Label id={id} render={<p />}>
        {title}
      </Label>
      <List
        className={cn(
          "flex flex-col gap-2 text-muted-foreground text-sm",
          list ? "list-disc ps-5" : GUIDE_STEPS,
        )}
      >
        {children}
      </List>
    </section>
  );
}

export type FlowStepState = "done" | "current" | "todo";

export interface FlowStepItem {
  state: FlowStepState;
  /** Unique within the flow; it keys the step. */
  title: string;
  /** What the step shows: a code, a link, a field. A step still to come usually has none. */
  children?: ReactNode;
}

const STEP_MARK: Record<FlowStepState, string> = {
  done: "bg-info-surface text-info-foreground",
  current: "bg-primary text-primary-foreground",
  todo: "border border-border text-muted-foreground",
};

/**
 * A sign-in as a short checklist: each step a numbered ring (a tick once done, filled while
 * current) joined by a hairline, its title, then whatever the step needs. The current step is
 * `aria-current="step"`; a done step says so to screen readers.
 */
export function FlowSteps({ steps }: { steps: FlowStepItem[] }): JSX.Element {
  const { t } = useT("add-account");
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li
            aria-current={step.state === "current" ? "step" : undefined}
            className="flex gap-3.5"
            data-state={step.state}
            key={step.title}
          >
            <span aria-hidden="true" className="flex flex-col items-center">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full font-semibold text-meta tabular-nums",
                  STEP_MARK[step.state],
                )}
              >
                {step.state === "done" ? (
                  <HugeiconsIcon className="size-3.5" icon={Tick02Icon} strokeWidth={2} />
                ) : (
                  index + 1
                )}
              </span>
              {last ? null : <span className="mt-1.5 w-px flex-1 bg-border" />}
            </span>
            <div className={cn("flex min-w-0 flex-1 flex-col gap-2 pt-0.5", !last && "pb-5")}>
              <p
                className={cn(
                  "font-medium text-sm",
                  step.state === "todo" && "text-muted-foreground",
                )}
              >
                {step.title}
                {step.state === "done" ? <span className="sr-only"> {t("stepDone")}</span> : null}
              </p>
              {step.children}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Free-text region, us-east-1 by default. The flow validates it with parseRegion on submit. */
export function RegionField({
  value,
  onChange,
  error,
  hint,
  disabled,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: ReactNode;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}): JSX.Element {
  const { t } = useT("add-account");
  return (
    <FormField error={error} hint={hint} label={t("region")}>
      <Input
        autoCapitalize="off"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="us-east-1"
        ref={inputRef}
        spellCheck={false}
        value={value}
      />
    </FormField>
  );
}

/**
 * The flow's submit button. While busy it is the Button's loading state (focusable, aria-busy,
 * clicks ignored) and takes focus from the fields that are disabled during the request, so
 * keyboard focus never falls to `<body>`. The flow's submit handler ignores a submit while busy.
 * The label stays while busy (a Spinner joins it), so the footer's Cancel does not jump.
 */
export function SubmitButton({
  formId,
  busy,
  label,
}: {
  formId: string;
  busy: boolean;
  label: string;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!busy) return;
    const active = document.activeElement;
    const form = document.getElementById(formId);
    if (!active || active === document.body || form?.contains(active)) ref.current?.focus();
  }, [busy, formId]);

  return (
    <Button form={formId} loading={busy} ref={ref} type="submit">
      {label}
    </Button>
  );
}
