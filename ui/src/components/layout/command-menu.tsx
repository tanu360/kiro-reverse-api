import {
  EyeOffIcon,
  LanguagesIcon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  type CSSProperties,
  createContext,
  type JSX,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { AppIcon } from "@/components/shared/app-icon";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandFooterPill,
  CommandGroup,
  CommandGroupLabel,
  CommandHint,
  CommandInput,
  CommandItem,
  CommandItemNote,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { LANGS, useLanguage, useT } from "@/lib/i18n";
import { usePrivacy } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { LANGUAGE_NAMES } from "./language-switch";
import { NAV_ITEMS } from "./nav-items";
import { THEMES, useTheme } from "./theme-provider";
import { THEME_ICONS } from "./theme-switch";
import { useUpdateCheck } from "./update-check";
import { useSignOut } from "./user-menu";

interface CommandEntry {
  value: string;
  label: string;
  icon: IconSvgElement;
  /** What the foot shows next to ↵ while this entry is highlighted. */
  verb: string;
  /** Muted text at the row's end. */
  note?: string;
  /** Label, group title and extra words, lower-cased, for the filter. */
  search: string;
  run: () => void;
}

interface CommandGroupEntry {
  value: string;
  label: string;
  items: CommandEntry[];
}

/** Space between the header trigger and the palette under it. */
const PALETTE_GAP = 8;

interface CommandMenuContextValue {
  open: boolean;
  /** Opens the palette from a trigger, which gets focus back when it closes. */
  openFrom: (trigger: HTMLElement) => void;
  /** Each trigger registers its button, so the palette can hang under the one on screen. */
  register: (trigger: HTMLButtonElement) => () => void;
}

const CommandMenuContext = createContext<CommandMenuContextValue | null>(null);

function useCommandMenu(): CommandMenuContextValue {
  const context = useContext(CommandMenuContext);
  if (!context) throw new Error("CommandMenuTrigger must be used within a CommandMenuProvider");
  return context;
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
}

/** Every typed word must appear somewhere in the entry's label, group or keywords. */
function matches(entry: CommandEntry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => entry.search.includes(term));
}

/**
 * The ⌘K palette, after the Raycast-style one in claude-guest-pass: centred, a search row, grouped
 * rows, and a foot naming what Enter does. Opens with ⌘K / Ctrl+K or a CommandMenuTrigger inside
 * the provider; picking an entry closes the menu and then runs it.
 */
export function CommandMenuProvider({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<CommandEntry | undefined>();
  const triggers = useRef(new Set<HTMLButtonElement>());
  /*
   * Where focus goes back when the palette is dismissed: the trigger that opened it, or what had
   * focus when ⌘K opened it. The triggers are plain buttons, not Dialog triggers, so without this
   * the dialog drops focus on the body. Running an entry clears it, as the command may move focus.
   */
  const opener = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [anchor, setAnchor] = useState<CSSProperties>();
  const { toggle: togglePrivacy } = usePrivacy();
  const { theme, setTheme } = useTheme();
  const { lang, setLang } = useLanguage();
  const { checkNow } = useUpdateCheck();
  const signOut = useSignOut();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (!openRef.current) {
        const active = document.activeElement;
        opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      setOpen((value) => !value);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const register = useCallback((trigger: HTMLButtonElement) => {
    triggers.current.add(trigger);
    return () => {
      triggers.current.delete(trigger);
    };
  }, []);

  // The palette hangs 8 px under the visible trigger (the field from sm up, the icon below),
  // centred on it, and follows it when the window resizes. No trigger with a box leaves the
  // stylesheet's centred default.
  const place = useCallback(() => {
    const box = [...triggers.current]
      .map((trigger) => trigger.getBoundingClientRect())
      .find((rect) => rect.width > 0);
    if (!box) return setAnchor(undefined);
    setAnchor({
      "--command-x": `${Math.round(box.left + box.width / 2)}px`,
      "--command-y": `${Math.round(box.bottom) + PALETTE_GAP}px`,
    } as CSSProperties);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, place]);

  // Each opening starts from an empty search.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const groups = useMemo<CommandGroupEntry[]>(() => {
    const group = (
      value: string,
      label: string,
      verb: string,
      items: Omit<CommandEntry, "verb" | "search">[],
      keywords = "",
    ): CommandGroupEntry => ({
      value,
      label,
      items: items.map((item) => ({
        ...item,
        verb,
        search: `${item.label} ${label} ${keywords}`.toLowerCase(),
      })),
    });
    const current = t("shell.command.current");
    return [
      group(
        "pages",
        t("shell.command.pages"),
        t("shell.command.open"),
        NAV_ITEMS.map((item) => ({
          value: `page-${item.id}`,
          label: t(item.labelKey),
          icon: item.icon,
          run: () => void navigate({ to: item.to }),
        })),
      ),
      group("actions", t("shell.command.actions"), t("shell.command.run"), [
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
      ]),
      group(
        "theme",
        t("shell.theme.title"),
        t("shell.command.apply"),
        THEMES.map((mode) => ({
          value: `theme-${mode}`,
          label: t(`shell.theme.${mode}`),
          icon: THEME_ICONS[mode],
          note: mode === theme ? current : undefined,
          run: () => setTheme(mode),
        })),
        "appearance mode",
      ),
      group(
        "language",
        t("shell.language"),
        t("shell.command.apply"),
        LANGS.map((code) => ({
          value: `language-${code}`,
          label: LANGUAGE_NAMES[code],
          icon: LanguagesIcon,
          note: code === lang ? current : undefined,
          run: () => setLang(code),
        })),
        "locale",
      ),
    ];
  }, [t, navigate, togglePrivacy, checkNow, signOut, theme, setTheme, lang, setLang]);

  // Closing first hands focus back to the page, so a command can then move it.
  const select = (entry: CommandEntry) => {
    opener.current = null;
    setOpen(false);
    entry.run();
  };

  const openFrom = useCallback((trigger: HTMLElement) => {
    opener.current = trigger;
    setOpen(true);
  }, []);

  const value = useMemo(() => ({ open, openFrom, register }), [open, openFrom, register]);

  return (
    <CommandMenuContext.Provider value={value}>
      {children}
      <CommandDialog onOpenChange={setOpen} open={open}>
        <CommandDialogPopup
          aria-label={t("shell.search")}
          finalFocus={() => (opener.current?.isConnected ? opener.current : false)}
          style={anchor}
        >
          <Command
            filter={(item, value) => matches(item as CommandEntry, value)}
            items={groups}
            onItemHighlighted={(item) => setActive(item as CommandEntry | undefined)}
            onValueChange={setQuery}
            value={query}
          >
            <CommandInput
              aria-label={t("shell.search")}
              placeholder={t("shell.command.placeholder")}
            />
            <CommandEmpty>{t("shell.command.noResults", { query: query.trim() })}</CommandEmpty>
            <CommandList>
              {(group: CommandGroupEntry) => (
                <CommandGroup items={group.items} key={group.value}>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  <CommandCollection>
                    {(entry: CommandEntry) => (
                      <CommandItem key={entry.value} onClick={() => select(entry)} value={entry}>
                        <HugeiconsIcon icon={entry.icon} aria-hidden="true" />
                        <span className="truncate font-medium">{entry.label}</span>
                        {entry.note ? <CommandItemNote>{entry.note}</CommandItemNote> : null}
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
          <CommandFooter>
            <CommandFooterPill className="w-10 justify-center">
              <AppIcon className="size-5 rounded-sm" size={20} />
            </CommandFooterPill>
            {/* The keys only mean something while a row is highlighted. */}
            {active ? (
              <CommandFooterPill className="gap-4 ps-4 pe-3 font-medium text-meta text-muted-foreground">
                <CommandHint className="text-foreground" keys={["↵"]} label={active.verb} />
                <CommandHint keys={["↑", "↓"]} label={t("shell.command.move")} />
              </CommandFooterPill>
            ) : null}
          </CommandFooter>
        </CommandDialogPopup>
      </CommandDialog>
    </CommandMenuContext.Provider>
  );
}

/**
 * Opens the palette. `field`: the header's search field (sm and up), a rounded field with the
 * shortcut at its end. `icon`: a quiet icon button like its header neighbours (phones).
 */
export function CommandMenuTrigger({
  variant = "field",
  className,
}: {
  variant?: "field" | "icon";
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const { open, openFrom, register } = useCommandMenu();
  const ref = useCallback(
    (trigger: HTMLButtonElement | null) => (trigger ? register(trigger) : undefined),
    [register],
  );
  const shared = {
    "aria-expanded": open,
    "aria-haspopup": "dialog" as const,
    "aria-keyshortcuts": "Meta+K Control+K",
    "aria-label": t("shell.search"),
    onClick: (event: MouseEvent<HTMLButtonElement>) => openFrom(event.currentTarget),
    ref,
  };

  if (variant === "icon") {
    return (
      <Button {...shared} className={className} size="icon" variant="quiet">
        <AnimatedIcon icon={Search01Icon} aria-hidden="true" />
      </Button>
    );
  }

  return (
    <button
      {...shared}
      className={cn(
        "group focus-outline flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-field-border bg-field ps-3 pe-1.5 text-muted-foreground text-sm outline-none transition-[background-color,color] duration-150 ease-out hover:bg-field-hover hover:text-foreground aria-expanded:bg-field-hover aria-expanded:text-foreground pointer-coarse:h-10",
        className,
      )}
      type="button"
    >
      <HugeiconsIcon icon={Search01Icon} aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-start">{t("shell.search")}</span>
      <Kbd
        aria-hidden="true"
        className="shrink-0 transition-colors group-hover:text-foreground group-aria-expanded:text-foreground"
      >
        {isMac() ? "⌘" : "Ctrl"} K
      </Kbd>
    </button>
  );
}
