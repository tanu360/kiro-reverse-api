import { GlobeIcon, LanguagesIcon } from "lucide-react";
import type { JSX } from "react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { LANGUAGES, type SupportedLang, useLanguage, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Language names are shown in their own script, whatever the active language. */
export const LANGUAGE_NAMES: Record<SupportedLang, string> = Object.fromEntries(
  LANGUAGES.map((option) => [option.code, option.nativeLabel]),
) as Record<SupportedLang, string>;

/**
 * `icon`: a bare icon button (the app header). `pill`: a globe and the current language's short
 * tag, for the segmented control on the sign-in pages.
 */
export function LanguageSwitch({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "pill";
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const { lang, setLang } = useLanguage();
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
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuRadioGroup onValueChange={(value) => setLang(value as SupportedLang)} value={lang}>
            {LANGUAGES.map((option) => (
              <MenuRadioItem key={option.code} lang={option.code} value={option.code}>
                {option.nativeLabel}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
