import type { JSX } from "react";
import { PasswordInput } from "@/components/shared/password-input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { useT } from "@/lib/i18n";

/**
 * The admin password field of the sign-in form: the shared PasswordInput in its sign-in size
 * (lg, with the lock icon and the eye toggle) inside a Base UI field, which links the error text
 * to the input through aria-describedby.
 */
export function PasswordField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}): JSX.Element {
  const { t } = useT("auth");
  return (
    <Field className="w-full items-stretch" invalid={Boolean(error)}>
      <FieldLabel className="sr-only">{t("password")}</FieldLabel>
      <PasswordInput
        autoComplete="current-password"
        autoFocus
        invalid={Boolean(error)}
        lockIcon
        name="password"
        onChange={onChange}
        placeholder={t("passwordPlaceholder")}
        size="lg"
        value={value}
      />
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}
