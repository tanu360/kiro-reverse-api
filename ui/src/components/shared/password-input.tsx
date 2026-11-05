import { EyeIcon, EyeOffIcon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import type { InputProps } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";

type PasswordInputProps = Omit<
  InputProps,
  "size" | "type" | "value" | "onChange" | "className" | "unstyled" | "nativeInput"
> & {
  value: string;
  onChange: (value: string) => void;
  /** `lg` is the sign-in field (44 px on phones and touch screens, 40 px from sm up). */
  size?: "default" | "lg";
  /** A lock icon at the start, as on the sign-in page. */
  lockIcon?: boolean;
  invalid?: boolean;
  /** The id of the hint or error that describes the field. */
  describedBy?: string;
  /** The toggle's names; "Show password" and "Hide password" by default. */
  showLabel?: string;
  hideLabel?: string;
  /** On the group: layout only. */
  className?: string;
};

/**
 * The sign-in password field, for every password in the app: the soft field with an optional
 * lock icon, and a quiet eye button at the end that shows or hides the text. The toggle is a
 * pressed-state button with a tooltip; its touch target comes from the Button's icon size.
 * Inside a Base UI Field the input takes the field's label, id and error wiring.
 */
export function PasswordInput({
  value,
  onChange,
  size = "default",
  lockIcon = false,
  invalid,
  describedBy,
  showLabel,
  hideLabel,
  className,
  ...inputProps
}: PasswordInputProps): JSX.Element {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  const label = visible
    ? (hideLabel ?? t("form.hidePassword"))
    : (showLabel ?? t("form.showPassword"));
  const ToggleIcon = visible ? EyeOffIcon : EyeIcon;
  return (
    <InputGroup className={className}>
      {lockIcon ? (
        <InputGroupAddon>
          <HugeiconsIcon icon={SquareLock02Icon} aria-hidden="true" />
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        {...inputProps}
        onChange={(event) => onChange(event.target.value)}
        size={size}
        type={visible ? "text" : "password"}
        value={value}
      />
      <InputGroupAddon align="inline-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={label}
                aria-pressed={visible}
                onClick={() => setVisible((shown) => !shown)}
                size="icon-sm"
                variant="quiet"
              />
            }
          >
            <AnimatedIcon icon={ToggleIcon} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
      </InputGroupAddon>
    </InputGroup>
  );
}
