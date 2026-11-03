import { AlertCircleIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A long sign-in URL that wraps, with Open and Copy buttons sized for touch. */
export function UrlBox({ label, url }: { label: string; url: string }): JSX.Element {
  const { t } = useT("add-account");
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium text-sm">{label}</span>
      <code className="block break-all rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs">
        {url}
      </code>
      <div className="flex gap-2">
        <Button
          className="h-10 flex-1 sm:h-8"
          onClick={() => window.open(url, "_blank", "noopener")}
          size="sm"
          variant="outline"
        >
          <ExternalLinkIcon aria-hidden="true" />
          {t("open")}
        </Button>
        <CopyButton
          className="h-10 flex-1 sm:h-8"
          label={t("copyLink")}
          showLabel
          size="sm"
          value={url}
          variant="outline"
        />
      </div>
    </div>
  );
}

/** Label, control, hint and field error, wired together by Base UI Field. */
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
  className?: string;
}): JSX.Element {
  return (
    <Field className={cn("w-full", className)} invalid={Boolean(error)}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <FieldError match={Boolean(error)}>{error}</FieldError>
    </Field>
  );
}

/** Free-text region, us-east-1 by default. The flow validates it with parseRegion on submit. */
export function RegionField({
  value,
  onChange,
  error,
  hint,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useT("add-account");
  return (
    <FormField error={error} hint={hint} label={t("region")}>
      <Input
        autoCapitalize="off"
        autoComplete="off"
        className="font-mono"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="us-east-1"
        spellCheck={false}
        value={value}
      />
    </FormField>
  );
}

/** Validation problems that are not tied to one field. */
export function FormAlert({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Alert variant="error">
      <AlertCircleIcon aria-hidden="true" />
      <AlertDescription className="text-foreground">{children}</AlertDescription>
    </Alert>
  );
}

/** A submit button that shows a spinner and a progress label while busy. */
export function SubmitButton({
  formId,
  busy,
  label,
  busyLabel,
}: {
  formId: string;
  busy: boolean;
  label: string;
  busyLabel: string;
}): JSX.Element {
  return (
    <Button className="h-10 sm:h-8" disabled={busy} form={formId} type="submit">
      {busy ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
      {busy ? busyLabel : label}
    </Button>
  );
}

/** Inline code for file names, cookie names and hosts in help text. */
export function Code({ children }: { children: ReactNode }): JSX.Element {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground text-xs">
      {children}
    </code>
  );
}

export function HelpText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <p className={cn("text-muted-foreground text-sm", className)}>{children}</p>;
}
