"use client";

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { MinusIcon, PlusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { useUiT } from "@/components/ui/messages";
import { intlLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface NumberFieldContextValue {
  fieldId: string;
  /** Characters the field never takes: a sign when it cannot go below 0, a decimal mark when
   * it holds whole numbers. */
  blocked: ReadonlySet<string>;
}

const NumberFieldContext: React.Context<NumberFieldContextValue | null> =
  React.createContext<NumberFieldContextValue | null>(null);

/** Every minus and plus sign Base UI reads as one (ASCII, typographic and full-width). */
const SIGN_CHARS = [
  "-",
  "\u2212",
  "\u2010",
  "\u2012",
  "\u2013",
  "\u2014",
  "\ufe63",
  "\uff0d",
  "+",
  "\uff0b",
];

/** The locale's decimal mark: "." in English and Chinese, "," in pt-BR and Vietnamese. */
function decimalMark(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
      ?.value ?? "."
  );
}

/**
 * Base UI's field already refuses letters, but it always takes a minus sign and a decimal mark.
 * A field that cannot go below 0 refuses signs too, and one whose step and format are whole
 * refuses the decimal mark ("1-0" or "2.5" in a count of days never shows).
 */
function blockedChars(
  locale: string,
  min: number | undefined,
  step: number | "any" | undefined,
  format: Intl.NumberFormatOptions | undefined,
): ReadonlySet<string> {
  const blocked = new Set<string>();
  if (min !== undefined && min >= 0) for (const sign of SIGN_CHARS) blocked.add(sign);
  const whole =
    step !== "any" && Number.isInteger(step ?? 1) && !((format?.maximumFractionDigits ?? 0) > 0);
  if (whole) blocked.add(decimalMark(locale));
  return blocked;
}

export function NumberField({
  id,
  className,
  size = "default",
  ...props
}: NumberFieldPrimitive.Root.Props & {
  size?: "sm" | "default" | "lg";
}): React.ReactElement {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  // Group and parse the number the UI language's way ("4.500" in pt-BR), not the browser's.
  const { lang } = useUiT();
  const locale = intlLocale(lang);
  const { min, step, format } = props;
  const blocked = React.useMemo(
    () => blockedChars(locale, min, step, format),
    [locale, min, step, format],
  );
  const context = React.useMemo(() => ({ fieldId, blocked }), [fieldId, blocked]);

  return (
    <NumberFieldContext.Provider value={context}>
      <NumberFieldPrimitive.Root
        className={cn("flex w-full flex-col items-start gap-2", className)}
        data-size={size}
        data-slot="number-field"
        id={fieldId}
        locale={locale}
        {...props}
      />
    </NumberFieldContext.Provider>
  );
}

export function NumberFieldGroup({
  className,
  ...props
}: NumberFieldPrimitive.Group.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Group
      className={cn(
        "relative flex w-full justify-between rounded-lg border border-field-border bg-field text-control text-foreground transition-[background-color,border-color] duration-150 hover:bg-field-hover focus-within:border-field-border-focus focus-within:bg-field-focus has-aria-invalid:border-destructive/36 has-autofill:bg-foreground/4 focus-within:has-aria-invalid:border-destructive/64 data-disabled:pointer-events-none data-disabled:opacity-64 dark:has-autofill:bg-foreground/8 [&_svg:not([class*='size-'])]:size-4 icon-slot",
        className,
      )}
      data-slot="number-field-group"
      {...props}
    />
  );
}

export function NumberFieldDecrement({
  className,
  ...props
}: NumberFieldPrimitive.Decrement.Props): React.ReactElement {
  const { t } = useUiT();
  return (
    <NumberFieldPrimitive.Decrement
      aria-label={t("numberField.decrease")}
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-s-[calc(var(--radius-lg)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent",
        className,
      )}
      data-slot="number-field-decrement"
      {...props}
    >
      <HugeiconsIcon icon={MinusIcon} />
    </NumberFieldPrimitive.Decrement>
  );
}

export function NumberFieldIncrement({
  className,
  ...props
}: NumberFieldPrimitive.Increment.Props): React.ReactElement {
  const { t } = useUiT();
  return (
    <NumberFieldPrimitive.Increment
      aria-label={t("numberField.increase")}
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-e-[calc(var(--radius-lg)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent",
        className,
      )}
      data-slot="number-field-increment"
      {...props}
    >
      <HugeiconsIcon icon={PlusIcon} />
    </NumberFieldPrimitive.Increment>
  );
}

export function NumberFieldInput({
  className,
  onBeforeInput,
  onKeyDown,
  ...props
}: NumberFieldPrimitive.Input.Props): React.ReactElement {
  const { t } = useUiT();
  const blocked = React.useContext(NumberFieldContext)?.blocked;
  return (
    <NumberFieldPrimitive.Input
      aria-roledescription={t("numberField.roleDescription")}
      // A key on a hardware keyboard stops here; a phone keyboard and a paste, which send no
      // usable key, stop in onBeforeInput. Either way the character never flashes in.
      onKeyDown={(event) => {
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
        if (plain && event.key.length === 1 && blocked?.has(event.key)) event.preventDefault();
        onKeyDown?.(event);
      }}
      onBeforeInput={(event) => {
        const data = (event as unknown as { data?: string | null }).data;
        if (blocked?.size && data && Array.from(data).some((char) => blocked.has(char))) {
          event.preventDefault();
        }
        onBeforeInput?.(event);
      }}
      className={cn(
        // The field heights of input.tsx, border included: 36 by default and 32 sm on phones and
        // desktops alike, 44 / 40 lg, and 40 / 36 on a coarse pointer (44 lg).
        "h-8.5 in-data-[size=lg]:h-10.5 in-data-[size=sm]:h-7.5 w-full min-w-0 grow bg-transparent in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] text-center text-foreground tabular-nums outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:in-data-[size=lg]:h-9.5 pointer-coarse:h-9.5 pointer-coarse:in-data-[size=sm]:h-8.5 pointer-coarse:in-data-[size=lg]:h-10.5",
        className,
      )}
      data-slot="number-field-input"
      {...props}
    />
  );
}
