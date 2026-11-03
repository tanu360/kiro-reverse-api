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
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { HEADER_ICON_BUTTON } from "./header-button";
import { THEMES, type Theme, useTheme } from "./theme-provider";

export const THEME_ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/** Same order as the old UI: system, light, dark. */
function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
}

/**
 * `icon`: one button that steps through the modes (the app header). `menu`: a button that opens
 * the modes as a menu. `segmented`: all three modes side by side as a flat icon toggle, the
 * current one highlighted, for the sign-in pages' footer.
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

  if (variant === "segmented") {
    return (
      <SegmentedControl
        aria-label={t("shell.theme.title")}
        // Flat: a hairline frame, no track fill, and a shadowless round highlight.
        className={cn(
          "gap-0 rounded-full border bg-transparent p-px *:data-[slot=segmented-control-indicator]:rounded-full *:data-[slot=segmented-control-indicator]:bg-accent *:data-[slot=segmented-control-indicator]:shadow-none dark:*:data-[slot=segmented-control-indicator]:bg-accent",
          className,
        )}
        role="group"
        size="sm"
      >
        {THEMES.map((mode) => {
          const ModeIcon = THEME_ICONS[mode];
          const modeLabel = t(`shell.theme.${mode}`);
          const active = mode === theme;
          return (
            <Tooltip key={mode}>
              <TooltipTrigger
                render={
                  <SegmentedControlItem
                    aria-label={modeLabel}
                    aria-pressed={active}
                    // 40 px below md and on touch screens (touch rule), 32 px from md up, with
                    // the segmented control's own 18 / 16 px icons.
                    className="size-10 rounded-full p-0 data-pressed:bg-accent data-pressed:shadow-none sm:size-10 md:size-8 pointer-coarse:size-10"
                    data-pressed={active ? "" : undefined}
                    onClick={() => setTheme(mode)}
                  />
                }
              >
                <ModeIcon aria-hidden="true" />
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
                    className={HEADER_ICON_BUTTON}
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
            className={cn(HEADER_ICON_BUTTON, className)}
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
