import { CheckIcon, ChevronDownIcon, GlobeIcon, LanguagesIcon } from "lucide-react";
import type { JSX } from "react";
import { FlagIcon } from "@/components/shared/flag-icon";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuPrimitive,
  MenuRadioGroup,
  MenuTrigger,
} from "@/components/ui/menu";
import { Select, SelectPopup, SelectPrimitive } from "@/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { LANGUAGES, type SupportedLang, useLanguage, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Language names are shown in their own script, whatever the active language. */
export const LANGUAGE_NAMES: Record<SupportedLang, string> = Object.fromEntries(
  LANGUAGES.map((option) => [option.code, option.nativeLabel]),
) as Record<SupportedLang, string>;

/**
 * One language as a single-line row: its flag, its name in its own script, and a checked dot
 * (CheckedDot) at the end on the current one. 40 px on phones, 32 px from sm up.
 */
/** The current language's mark: a white check in a filled Kiro-purple circle. */
function CheckedDot(): JSX.Element {
  return (
    <span className="grid size-4.5 place-items-center rounded-full bg-primary text-primary-foreground">
      <CheckIcon aria-hidden="true" className="size-3" strokeWidth={3} />
    </span>
  );
}

const ROW =
  "flex min-h-10 cursor-default items-center gap-2.5 rounded-md px-2 text-foreground text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-disabled:opacity-64 sm:min-h-8";

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
                  className={cn(pill ? "h-10 gap-1.5 px-3 md:h-8" : "size-10 md:size-8", className)}
                  size={pill ? "sm" : "icon"}
                  variant="ghost"
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
              <MenuPrimitive.RadioItem
                className={ROW}
                data-slot="menu-radio-item"
                key={option.code}
                lang={option.code}
                value={option.code}
              >
                <FlagIcon code={option.code} />
                {option.nativeLabel}
                <MenuPrimitive.RadioItemIndicator className="ms-auto">
                  <CheckedDot />
                </MenuPrimitive.RadioItemIndicator>
              </MenuPrimitive.RadioItem>
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
        {LANGUAGES.map((option) => (
          <SelectPrimitive.Item
            className={cn(ROW, "pe-2.5")}
            key={option.code}
            lang={option.code}
            value={option.code}
          >
            <SelectPrimitive.ItemText className="flex items-center gap-2.5">
              <FlagIcon code={option.code} />
              {option.nativeLabel}
            </SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="ms-auto ps-3">
              <CheckedDot />
            </SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>
        ))}
      </SelectPopup>
    </Select>
  );
}
