import { LanguagesIcon } from "@hugeicons/core-free-icons";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectPrimitive,
  SelectTrigger,
} from "@/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { LANGUAGES, type SupportedLang, useLanguage, useT } from "@/lib/i18n";

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
 * The sign-in pages' language picker: the shared select trigger (the current flag and name, a
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
            // As wide as the current name; the shared default size, so it stands as tall as the
            // theme toggle across the row (36 / 32 px, 40 on touch).
            <SelectTrigger aria-label={triggerLabel} className={className} fit="content" />
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
        </TooltipTrigger>
        <TooltipPopup>{triggerLabel}</TooltipPopup>
      </Tooltip>
      {/* The trigger is as narrow as the current name, so the list grows to fit its rows. */}
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
