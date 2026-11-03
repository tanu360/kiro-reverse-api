import { EyeIcon, EyeOffIcon, LockIcon } from "lucide-react";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Icon buttons on the sign-in pages (the show/hide toggle, copy): no hover or pressed fill, only
 * the icon colour moves from muted to full. Full opacity, so muted is the real resting colour.
 */
export const FLAT_ICON_BUTTON_CLASS =
  "text-muted-foreground hover:bg-transparent hover:text-foreground active:text-foreground data-pressed:bg-transparent data-pressed:text-foreground [&_svg:not([class*='opacity-'])]:opacity-100";

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
      {/*
       * Flat sign-in pages: no drop shadow (the ::before layer only draws one). The field is
       * 44 px tall on phones and touch screens and 40 px from sm up (42 / 38 px of input inside
       * the 1 px border), the submit button's height.
       */}
      <InputGroup className="shadow-none before:hidden [&_[data-slot=input]]:h-10.5 [&_[data-slot=input]]:leading-10.5 sm:[&_[data-slot=input]]:h-9.5 sm:[&_[data-slot=input]]:leading-9.5 pointer-coarse:[&_[data-slot=input]]:h-10.5 pointer-coarse:[&_[data-slot=input]]:leading-10.5">
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
          {/* 40 px on phones (touch target rule), the compact size from md up. */}
          <Button
            aria-label={visible ? t("hidePassword") : t("showPassword")}
            className={cn("max-md:size-10", FLAT_ICON_BUTTON_CLASS)}
            onClick={() => setVisible((shown) => !shown)}
            size="icon-sm"
            variant="ghost"
          >
            <ToggleIcon aria-hidden="true" />
          </Button>
        </InputGroupAddon>
      </InputGroup>
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}
