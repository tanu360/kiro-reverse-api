import { EyeIcon, EyeOffIcon, LockIcon } from "lucide-react";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useT } from "@/lib/i18n";

/**
 * The admin password input with a show/hide toggle. The error text is linked to the input
 * through aria-describedby by the Base UI field.
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
  const [visible, setVisible] = useState(false);
  const ToggleIcon = visible ? EyeOffIcon : EyeIcon;

  return (
    <Field className="w-full" invalid={Boolean(error)}>
      <FieldLabel className="sr-only">{t("password")}</FieldLabel>
      {/* The lg field (components/ui/input.tsx): 44 px on phones and touch screens, 40 px from sm up. */}
      <InputGroup>
        <InputGroupAddon>
          <LockIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          autoComplete="current-password"
          autoFocus
          name="password"
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("passwordPlaceholder")}
          size="lg"
          type={visible ? "text" : "password"}
          value={value}
        />
        <InputGroupAddon align="inline-end">
          {/*
           * A quiet icon button: no fill, only the icon colour moves from muted to full. 40 px on
           * phones (touch target rule), the compact size from md up.
           */}
          <Button
            aria-label={visible ? t("hidePassword") : t("showPassword")}
            className="max-md:size-10"
            onClick={() => setVisible((shown) => !shown)}
            size="icon-sm"
            variant="quiet"
          >
            <ToggleIcon aria-hidden="true" />
          </Button>
        </InputGroupAddon>
      </InputGroup>
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}
