import type { JSX, Ref } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { digitsOnly, recoveryCodeChars } from "@/lib/input-filters";

/**
 * The code field of the sign-in form's second step, in the password field's sign-in size (lg).
 * A code from the app takes digits from the phone's number pad and the one-time-code autofill;
 * a recovery code takes letters and digits.
 */
export function CodeField({
  value,
  onChange,
  error,
  recovery,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  recovery: boolean;
  ref?: Ref<HTMLInputElement>;
}): JSX.Element {
  const { t } = useT("auth");
  return (
    <Field className="w-full items-stretch" invalid={Boolean(error)}>
      <FieldLabel className="sr-only">{recovery ? t("recoveryLabel") : t("codeLabel")}</FieldLabel>
      <Input
        aria-invalid={Boolean(error) || undefined}
        autoCapitalize="none"
        autoComplete={recovery ? "off" : "one-time-code"}
        autoCorrect="off"
        autoFocus
        inputMode={recovery ? "text" : "numeric"}
        maxLength={recovery ? 32 : 9}
        name={recovery ? "recovery-code" : "one-time-code"}
        // The app's code keeps digits only, at most six ("123 456" pasted lands as "123456");
        // a recovery code ("k7xq2-m9fd4") keeps its letters, digits and hyphens.
        onChange={(event) =>
          onChange(
            recovery ? recoveryCodeChars(event.target.value) : digitsOnly(event.target.value, 6),
          )
        }
        placeholder={recovery ? t("recoveryPlaceholder") : t("codePlaceholder")}
        ref={ref}
        size="lg"
        spellCheck={false}
        value={value}
        variant="code"
      />
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}
