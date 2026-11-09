import { MonitorIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { type JSX, useRef } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
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

export const THEME_ICONS = { system: MonitorIcon, light: Sun03Icon, dark: Moon02Icon } as const;

/** Same order as the old UI: system, light, dark. */
function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
}

/**
 * `icon`: one quiet button that steps through the modes (system → light → dark), for the sign-in,
 * 404 and error pages' top row; like the language trigger beside it, hovering only moves the
 * colour. `menu`: a button that opens the modes as a radio menu, like the language menu beside it
 * (the app header).
 */
export function ThemeSwitch({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "menu";
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const { theme, setTheme } = useTheme();
  const label = t("shell.theme.label", { mode: t(`shell.theme.${theme}`) });
  const Icon = THEME_ICONS[theme];
  // The menu variant's button: the reveal grows from it, as the menu item is gone by then.
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

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
                    className={className}
                    data-theme-mode={theme}
                    ref={menuTriggerRef}
                    size="icon"
                    variant="quiet"
                  />
                }
              />
            }
          >
            <AnimatedIcon icon={Icon} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
        {/* Its end edge meets the trigger's; on a phone MenuPopup's collision padding keeps it
            on the 16 px gutter. */}
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>{t("shell.theme.title")}</MenuGroupLabel>
            <MenuRadioGroup
              onValueChange={(value) => setTheme(value as Theme, menuTriggerRef.current)}
              value={theme}
            >
              {THEMES.map((mode) => {
                const ModeIcon = THEME_ICONS[mode];
                return (
                  <MenuRadioItem key={mode} value={mode}>
                    <AnimatedIcon icon={ModeIcon} aria-hidden="true" />
                    {t(`shell.theme.${mode}`)}
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
            className={className}
            data-theme-mode={theme}
            onClick={(event) => setTheme(nextTheme(theme), event.currentTarget)}
            size="icon"
            variant="quiet"
          />
        }
      >
        <AnimatedIcon icon={Icon} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
