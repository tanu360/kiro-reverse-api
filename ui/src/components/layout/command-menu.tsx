import { useNavigate } from "@tanstack/react-router";
import {
  EyeOffIcon,
  LanguagesIcon,
  LogOutIcon,
  type LucideIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { Fragment, type JSX, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { LANGS, useLanguage, useT } from "@/lib/i18n";
import { usePrivacy } from "@/lib/privacy";
import { LANGUAGE_NAMES } from "./language-switch";
import { NAV_ITEMS } from "./nav-items";
import { THEMES, useTheme } from "./theme-provider";
import { THEME_ICONS } from "./theme-switch";
import { useUpdateCheck } from "./update-check";
import { useSignOut } from "./user-menu";

interface CommandEntry {
  value: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

interface CommandGroupEntry {
  value: string;
  label: string;
  items: CommandEntry[];
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
}

/**
 * Port of Studio Admin's search dialog onto coss CommandDialog. Opens with ⌘K / Ctrl+K or the
 * header trigger; picking an entry runs it and closes the menu.
 */
export function CommandMenu(): JSX.Element {
  const { t } = useT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { toggle: togglePrivacy } = usePrivacy();
  const { setTheme } = useTheme();
  const { setLang } = useLanguage();
  const { checkNow } = useUpdateCheck();
  const signOut = useSignOut();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const groups = useMemo<CommandGroupEntry[]>(
    () => [
      {
        value: "pages",
        label: t("shell.command.pages"),
        items: NAV_ITEMS.map((item) => ({
          value: `page-${item.id}`,
          label: t(item.labelKey),
          icon: item.icon,
          run: () => void navigate({ to: item.to }),
        })),
      },
      {
        value: "actions",
        label: t("shell.command.actions"),
        items: [
          {
            value: "action-add-account",
            label: t("shell.addAccount"),
            icon: PlusIcon,
            run: () => void navigate({ to: "/accounts", search: { add: true } }),
          },
          {
            value: "action-privacy",
            label: t("shell.command.togglePrivacy"),
            icon: EyeOffIcon,
            run: togglePrivacy,
          },
          {
            value: "action-update",
            label: t("shell.update.check"),
            icon: RefreshCwIcon,
            run: checkNow,
          },
          {
            value: "action-sign-out",
            label: t("shell.signOut"),
            icon: LogOutIcon,
            run: () => void signOut(),
          },
        ],
      },
      {
        value: "theme",
        label: t("shell.theme.title"),
        items: THEMES.map((mode) => ({
          value: `theme-${mode}`,
          label: t(`shell.theme.${mode}`),
          icon: THEME_ICONS[mode],
          run: () => setTheme(mode),
        })),
      },
      {
        value: "language",
        label: t("shell.language"),
        items: LANGS.map((code) => ({
          value: `language-${code}`,
          label: LANGUAGE_NAMES[code],
          icon: LanguagesIcon,
          run: () => setLang(code),
        })),
      },
    ],
    [t, navigate, togglePrivacy, checkNow, signOut, setTheme, setLang],
  );

  const select = (entry: CommandEntry) => {
    setOpen(false);
    entry.run();
  };

  return (
    <>
      <Button
        aria-keyshortcuts="Meta+K Control+K"
        aria-label={t("shell.search")}
        // Icon-only and 40x40 below sm; with its label from sm up.
        className="size-10 gap-2 px-2 font-normal sm:w-auto md:h-8"
        onClick={() => setOpen(true)}
        variant="quiet"
      >
        <SearchIcon aria-hidden="true" />
        <span className="hidden sm:inline">{t("shell.search")}</span>
        <Kbd aria-hidden="true" className="hidden sm:inline-flex">
          {isMac() ? "⌘" : "Ctrl"} K
        </Kbd>
      </Button>
      <CommandDialog onOpenChange={setOpen} open={open}>
        <CommandDialogPopup aria-label={t("shell.search")}>
          <Command items={groups}>
            <CommandInput
              aria-label={t("shell.search")}
              placeholder={t("shell.command.placeholder")}
            />
            <CommandPanel>
              <CommandEmpty>{t("state.noMatches")}</CommandEmpty>
              <CommandList>
                {(group: CommandGroupEntry, index: number) => (
                  <Fragment key={group.value}>
                    {index > 0 ? <CommandSeparator /> : null}
                    <CommandGroup items={group.items}>
                      <CommandGroupLabel>{group.label}</CommandGroupLabel>
                      <CommandCollection>
                        {(entry: CommandEntry) => {
                          const Icon = entry.icon;
                          return (
                            <CommandItem
                              key={entry.value}
                              onClick={() => select(entry)}
                              value={entry}
                            >
                              <Icon aria-hidden="true" className="size-4 opacity-80" />
                              <span className="truncate">{entry.label}</span>
                            </CommandItem>
                          );
                        }}
                      </CommandCollection>
                    </CommandGroup>
                  </Fragment>
                )}
              </CommandList>
            </CommandPanel>
          </Command>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}
