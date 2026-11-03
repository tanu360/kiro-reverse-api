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
import { LANGS, type Lang, useLanguage, useT } from "@/lib/i18n";

/** Language names are shown in their own script, whatever the active language. */
export const LANGUAGE_NAMES: Record<Lang, string> = { en: "English", zh: "中文" };

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
          <MenuRadioGroup onValueChange={(value) => setLang(value as Lang)} value={lang}>
            {LANGS.map((code) => (
              <MenuRadioItem key={code} lang={code} value={code}>
                {LANGUAGE_NAMES[code]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
