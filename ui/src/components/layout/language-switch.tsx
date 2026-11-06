import { ChevronDownIcon, LanguagesIcon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { FlagIcon } from "@/components/shared/flag-icon";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import { Select, SelectItem, SelectPopup, SelectPrimitive } from "@/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { LANGUAGES, type SupportedLang, useLanguage, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Language names are shown in their own script, whatever the active language. */
export const LANGUAGE_NAMES: Record<SupportedLang, string> = Object.fromEntries(
  LANGUAGES.map((option) => [option.code, option.nativeLabel]),
) as Record<SupportedLang, string>;

/**
 * `icon`: a quiet icon button that opens a radio menu (the app header). `flag`: the sign-in
 * pages' picker, a select that opens over itself (see LanguageSelect).
 */
export function LanguageSwitch({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "flag";
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const { lang, setLang } = useLanguage();
  if (variant === "flag") return <LanguageSelect className={className} />;

  const label = t("shell.language");

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button aria-label={label} className={className} size="icon" variant="quiet" />
              }
            />
          }
        >
          <AnimatedIcon icon={LanguagesIcon} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {/* Its end edge meets the trigger's; on a phone MenuPopup's collision padding keeps it on
          the 16 px gutter. */}
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuRadioGroup onValueChange={(value) => setLang(value as SupportedLang)} value={lang}>
            {LANGUAGES.map((option) => (
              <MenuRadioItem key={option.code} lang={option.code} value={option.code}>
                <FlagIcon code={option.code} />
                {option.nativeLabel}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The sign-in pages' language picker: a bare, borderless trigger (the current flag and name, a
 * chevron) and a select popup at least as wide as it. With a mouse the popup opens over the
 * trigger, the current language's row sitting exactly where the trigger was (Base UI
 * alignItemWithTrigger), so the list reads as the trigger unfolding; the row repeats the
 * trigger's flag, name, size and padding so the two line up. Touch, or too little room, falls
 * back to a list below the trigger.
 */
function LanguageSelect({ className }: { className?: string }): JSX.Element {
  const { t } = useT();
  const { lang, setLang } = useLanguage();
  const current = LANGUAGES.find((option) => option.code === lang) ?? LANGUAGES[0];
  const triggerLabel = t("shell.languageCurrent", { name: current.nativeLabel });

  return (
    <Select onValueChange={(value) => setLang(value as SupportedLang)} value={current.code}>
      <Tooltip>
        <TooltipTrigger
          render={
            // A bare label, no border or fill: only the text colour moves on hover and while
            // the list is open. As tall as the theme toggle across the row (36 / 32 px, 40 on
            // touch).
            <SelectPrimitive.Trigger
              aria-label={triggerLabel}
              className={cn(
                "inline-flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-outline data-popup-open:text-foreground sm:h-8 pointer-coarse:h-10",
                className,
              )}
            />
          }
        >
          <SelectPrimitive.Value className="flex items-center gap-2.5">
            {(value: SupportedLang) => (
              <>
                <FlagIcon code={value} />
                {LANGUAGE_NAMES[value]}
              </>
            )}
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon className="flex">
            <AnimatedIcon icon={ChevronDownIcon} aria-hidden="true" className="size-4" />
          </SelectPrimitive.Icon>
        </TooltipTrigger>
        <TooltipPopup>{triggerLabel}</TooltipPopup>
      </Tooltip>
      {/* The trigger is a bare label, as narrow as the current name, so the list fits its rows. */}
      <SelectPopup fit="content">
        {/* Single-line rows (popup-row.tsx): flag, name, and the CheckedDot on the current one. */}
        {LANGUAGES.map((option) => (
          <SelectItem key={option.code} lang={option.code} value={option.code}>
            <FlagIcon code={option.code} />
            {option.nativeLabel}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
