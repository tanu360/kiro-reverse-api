import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
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
import { useT } from "@/lib/i18n";
import { THEMES, type Theme, useTheme } from "./theme-provider";

export const THEME_ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/** Same order as the old UI: system, light, dark. */
function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
}

export function ThemeSwitch({ variant = "icon" }: { variant?: "icon" | "menu" }): JSX.Element {
  const { t } = useT();
  const { theme, setTheme } = useTheme();
  const label = t("shell.theme.label", { mode: t(`shell.theme.${theme}`) });
  const Icon = THEME_ICONS[theme];

  if (variant === "menu") {
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
            <Icon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>{t("shell.theme.title")}</MenuGroupLabel>
            <MenuRadioGroup onValueChange={(value) => setTheme(value as Theme)} value={theme}>
              {THEMES.map((mode) => {
                const ModeIcon = THEME_ICONS[mode];
                return (
                  <MenuRadioItem key={mode} value={mode}>
                    <span className="flex items-center gap-2">
                      <ModeIcon aria-hidden="true" />
                      {t(`shell.theme.${mode}`)}
                    </span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="size-10 md:size-8"
            data-theme-mode={theme}
            onClick={() => setTheme(nextTheme(theme))}
            size="icon"
            variant="ghost"
          />
        }
      >
        <Icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
