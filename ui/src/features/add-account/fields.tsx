import { ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, type Ref, useEffect, useId, useRef } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { ROW_DESCRIPTION } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A sign-in link as one quiet line instead of a field (no box around it): the label, then the URL in mono cut to a
 * single line (Open and Copy carry the full address), with Open as a secondary
 * button and a copy icon at its end. A long OAuth URL no longer fills the step.
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
        <Button
          render={<a href={url} rel="noopener noreferrer" target="_blank" />}
          size="sm"
          variant="secondary"
        >
          <HugeiconsIcon icon={ExternalLinkIcon} aria-hidden="true" />
          {t("open")}
        </Button>
        <CopyButton label={t("copyLink")} size="icon-sm" value={url} variant="quiet" />
      </div>
    </div>
  );
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

/**
 * Where to find the value a flow asks for: a heading in the form-label style over numbered steps
 * (or, with `list`, bullet points) in muted body text. Items carry host and file names in Code.
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
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <Label id={id} render={<p />}>
        {title}
      </Label>
      <List
        className={cn(
          "flex flex-col gap-1.5 ps-5 text-muted-foreground text-sm",
          list ? "list-disc" : "list-decimal",
        )}
      >
        {children}
      </List>
    </section>
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
