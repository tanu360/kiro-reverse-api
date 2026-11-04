import { ChevronDownIcon, GlobeIcon, LanguagesIcon } from "lucide-react";
import type { JSX } from "react";
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
import { HEADER_ICON_BUTTON } from "./header-button";

/** Language names are shown in their own script, whatever the active language. */
export const LANGUAGE_NAMES: Record<SupportedLang, string> = Object.fromEntries(
  LANGUAGES.map((option) => [option.code, option.nativeLabel]),
) as Record<SupportedLang, string>;

/**
 * `icon`: a bare icon button that opens a menu (the app header). `pill`: a globe and the current
 * language's short tag, for a compact segmented bar. `flag`: the sign-in pages' picker, a select
 * that opens over itself (see LanguageSelect).
 */
export function LanguageSwitch({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "pill" | "flag";
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const { lang, setLang } = useLanguage();
  if (variant === "flag") return <LanguageSelect className={className} />;

  const label = t("shell.language");
  const current = LANGUAGES.find((option) => option.code === lang) ?? LANGUAGES[0];
  const pill = variant === "pill";
  const triggerLabel = pill ? t("shell.languageCurrent", { name: current.nativeLabel }) : label;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label={triggerLabel}
                  className={cn(pill ? "h-10 gap-1.5 px-3 md:h-8" : HEADER_ICON_BUTTON, className)}
                  size={pill ? "sm" : "icon"}
                  variant="quiet"
                />
              }
            />
          }
        >
          {pill ? (
            <>
              <GlobeIcon aria-hidden="true" />
              <span className="font-medium text-xs tracking-wide">{current.shortLabel}</span>
            </>
          ) : (
            <LanguagesIcon aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup>{triggerLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-48">
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
 * The sign-in pages' language picker: a flat trigger (the current flag and name, a chevron) and
 * a select popup at least as wide as it. With a mouse the popup opens over the trigger, the
 * current language's row sitting exactly where the trigger was (Base UI alignItemWithTrigger),
 * so the list reads as the trigger unfolding; the row repeats the trigger's flag, name, size and
 * padding so the two line up. Touch, or too little room, falls back to a list below the trigger.
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
            <SelectPrimitive.Trigger
              aria-label={triggerLabel}
              // Flat: only the text colour moves on hover and while the list is open.
              className={cn(
                "inline-flex h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-outline data-popup-open:text-foreground sm:h-8",
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
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </SelectPrimitive.Icon>
        </TooltipTrigger>
        <TooltipPopup>{triggerLabel}</TooltipPopup>
      </Tooltip>
      <SelectPopup>
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
