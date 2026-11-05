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
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { THEMES, type Theme, useTheme } from "./theme-provider";

export const THEME_ICONS = { system: MonitorIcon, light: Sun03Icon, dark: Moon02Icon } as const;

/** Same order as the old UI: system, light, dark. */
function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
}

/**
 * `icon`: one button that steps through the modes. `menu`: a button that opens the modes as a
 * radio menu, like the language menu beside it (the app header). `segmented`: all three modes
 * side by side as a radio group in the segmented icon track, the current one highlighted, for the
 * sign-in pages' top row.
 */
export function ThemeSwitch({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "menu" | "segmented";
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const { theme, setTheme } = useTheme();
  const label = t("shell.theme.label", { mode: t(`shell.theme.${theme}`) });
  const Icon = THEME_ICONS[theme];
  // The menu variant's button: the reveal grows from it, as the menu item is gone by then.
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  if (variant === "segmented") {
    // A radio group (coss p-radio-group-7): one tab stop, arrow keys move the choice.
    return (
      <SegmentedControl
        className={className}
        render={
          <RadioGroupPrimitive
            aria-label={t("shell.theme.title")}
            onValueChange={(value, details) =>
              setTheme(
                value as Theme,
                (details.event.target as Element | null)?.closest("[role=radio]"),
              )
            }
            value={theme}
          />
        }
        size="icon"
      >
        {THEMES.map((mode) => {
          const ModeIcon = THEME_ICONS[mode];
          const modeLabel = t(`shell.theme.${mode}`);
          return (
            <Tooltip key={mode}>
              <TooltipTrigger
                render={
                  <SegmentedControlItem
                    aria-label={modeLabel}
                    render={<RadioPrimitive.Root value={mode} />}
                  />
                }
              >
                <AnimatedIcon icon={ModeIcon} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup>{modeLabel}</TooltipPopup>
            </Tooltip>
          );
        })}
      </SegmentedControl>
    );
  }

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
