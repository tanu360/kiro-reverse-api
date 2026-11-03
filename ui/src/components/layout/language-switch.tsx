import { LanguagesIcon } from "lucide-react";
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

/** Language names are shown in their own script, whatever the active language. */
export const LANGUAGE_NAMES: Record<SupportedLang, string> = Object.fromEntries(
  LANGUAGES.map((option) => [option.code, option.nativeLabel]),
) as Record<SupportedLang, string>;

export function LanguageSwitch(): JSX.Element {
  const { t } = useT();
  const { lang, setLang } = useLanguage();
  const label = t("shell.language");

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label={label}
                  className="size-10 md:size-8"
                  size="icon"
                  variant="ghost"
                />
              }
            />
          }
        >
          <LanguagesIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
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
